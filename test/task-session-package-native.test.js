import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp } from './fixtures/native-lifecycle.js'
import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile, symlink, rm, readdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { get } from 'node:http'
import { once } from 'node:events'
import { available, reason, nativeTaskHost, latestInput, topicTaskCalls, modelToolValues, resolveContextInput } from './fixtures/task-session-native-host.js'

const exec = promisify(execFile)
const source = fileURLToPath(new URL('../packages/dingtalk-dsh-assistant/', import.meta.url))
const test = (name, run) => testRunner(name, { timeout: nativeLifecycleTimeout(30000), ...(!available ? { skip: reason } : {}) }, nativeLifecycle(30000, async t => {
  const resources = {}
  let closing
  const close = () => closing ??= (async () => {
    const h = await resources.host?.catch(() => undefined)
    if (t.signal.aborted && h) await diagnose(t, h)
    try { await resources.fiber?.dispose() }
    finally {
      try { await h?.close() } finally { await resources.store?.close() }
      resources.stage?.('host-resources-closed')
    }
  })()
  t.after(async () => {
    try {
      await close()
      if (resources.root) await rm(resources.root, { recursive: true, force: true })
      resources.stage?.('temporary-files-removed')
    } finally { resources.restoreEnv?.() }
  })
  try { await run(t, resources) }
  catch (error) {
    if (!t.signal.aborted) { const h = await resources.host?.catch(() => undefined); if (h) await diagnose(t, h) }
    throw error
  }
}))

const call = (name, args) => ({ name, args })
const finish = action => call('task_session_submit', { decision: { action, summary: 'Package verification.', evidence: [], limitations: [] } })

async function diagnose(t, h) {
  const pick = (value, fields) => Object.fromEntries(fields.map(key => [key, value[key]]))
  try {
    const tasks = await h.query?.('task.list') ?? []
    const executions = await h.query?.('execution.list') ?? []
    const wakes = (await Promise.all(tasks.map(task => h.query('wake.list', { taskId: task.taskId })))).flat()
    const recentModel = h.requests.slice(-8).map(request => {
      try {
        const input = latestInput(request)
        return { objective: input.objective, task: input.task?.taskId, requestId: input.requestId,
          executions: input.executions?.map(item => pick(item, ['executionId', 'objective', 'status', 'drained'])) }
      } catch (error) { return { inputError: error.message } }
    })
    t.diagnostic('package stopped state: ' + JSON.stringify({
      tasks: tasks.map(item => pick(item, ['taskId', 'status', 'control', 'drained', 'leaseEpoch', 'runSequence', 'waitingReason'])),
      executions: executions.map(item => ({ ...pick(item, ['executionId', 'status', 'drained', 'inputVersion']), objective: item.input?.objective })),
      pendingWakes: wakes.filter(item => item.state !== 'acked').map(item => pick(item, ['id', 'kind', 'state'])),
      modelCalls: h.requests.length, recentModel,
      toolErrors: h.toolResults.filter(item => item.result.isError).slice(-8).map(item => ({ name: item.name, result: JSON.stringify(item.result).slice(0, 600) })),
    }))
  } catch (error) { t.diagnostic('package state unavailable: ' + error.message) }
}

async function pack(t, resources) {
  const started = performance.now()
  const stage = name => t.diagnostic(`package ${name}: ${Math.round(performance.now() - started)}ms`)
  resources.stage = stage
  stage('begin')
  t.signal.throwIfAborted()
  const root = resources.root = await mkdtemp(join(tmpdir(), 'task-package-native-'))
  t.signal.throwIfAborted()
  const command = async (file, args, options = {}) => {
    t.signal.throwIfAborted()
    const pending = exec(file, args, { ...options, signal: t.signal })
    // execFile rejects on abort before the child necessarily exits. Join its
    // actual close event so tar/npm cannot write after root removal.
    const exited = new Promise(resolve => pending.child.once('close', resolve))
    try { return await pending } finally { await exited }
  }
  let manifest
  if (process.env.RELEASE_PACKAGE_DIRECTORY) {
    const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version
    const tarball = resolve(process.env.RELEASE_PACKAGE_DIRECTORY, 'zzusp-dingtalk-dsh-assistant-' + version + '.tgz')
    const { stdout } = await command('tar', ['-tf', tarball])
    manifest = { files: stdout.trim().split(/\r?\n/).map(path => ({ path: path.replace(/^package\//, '') })) }
    await command('tar', ['-xzf', tarball, '-C', root])
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
    t.signal.throwIfAborted()
    if (entry.isFile()) await copyFile(join(source, entry.name), join(staging, entry.name))
  }
  stage('staged')
  const { stdout } = await command(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', root, '--cache', join(root, 'npm-cache')], { cwd: staging })
  stage('packed')
  ;[manifest] = JSON.parse(stdout)
  await command('tar', ['-xzf', join(root, manifest.filename), '-C', root])
  }
  stage('extracted')
  const dir = join(root, 'package'), pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  // Inspect the extracted artifact, never resolve missing runtime imports from source.
  // Cover static imports/re-exports and literal dynamic imports/require calls in every packed JS file.
  const packedPaths = new Set(manifest.files.map(entry => entry.path))
  assert.ok(packedPaths.has('task-boundary-instructions.js'), 'The shared task boundary runtime must ship')
  for (const entry of manifest.files.filter(entry => entry.path.endsWith('.js'))) {
    t.signal.throwIfAborted()
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
    t.signal.throwIfAborted()
    assert.ok(!retired.test(entry.path), `Retired asset was packed: ${entry.path}`)
    assert.ok(!/SKILL\.md|source-map\.json|(?:^|\/)skills\//.test(entry.path))
    if (entry.path.endsWith('.js')) assert.doesNotMatch(await readFile(join(dir, entry.path), 'utf8'), /小小鹏|D:[/\\]baibu-agent|HiQ-AI\/dataset(?:-web)?|bytebase\.baibu/i)
  }
  stage('bytes-and-imports-verified')
  // Use the already installed official dependency tree; no source fallback or dependency download.
  const installed = createRequire(join(source, 'package.json'))
  for (const name of Object.keys(pkg.dependencies)) {
    t.signal.throwIfAborted()
    const target = dirname(installed.resolve(name + '/package.json'))
    const link = join(dir, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(await realpath(target), link, 'junction')
  }
  stage('dependency-links-ready')
  const delivery = await import(pathToFileURL(join(dir, 'notification-delivery.js')).href)
  assert.equal(typeof delivery.deliverTaskNotification, 'function')
  assert.equal(typeof (await import(pathToFileURL(join(dir, 'dws-adapter.js')).href)).createDwsAdapter, 'function')
  t.signal.throwIfAborted()
  return { root, dir, pkg, manifest, stage }
}

test('actual npm tarball has only the generic runtime and runs a personal-skill task from its extracted files', async (t, resources) => {
  await t.beginBusiness()
  const f = await t.step(async () => pack(t, resources)), service = await t.step(async () => import(pathToFileURL(join(f.dir, 'task-session-service.js')).href))
  assert.equal((await t.step(async () => import(pathToFileURL(join(f.dir, 'index.js')).href))).name, 'dingtalk-dsh-assistant-web')
  f.stage('runtime-imports-ready')
  const personal = join(f.root, 'personal'), work = join(f.root, 'runtime')
  await t.step(async () => mkdir(join(personal, 'external-guide'), { recursive: true })); await t.step(async () => mkdir(work))
  t.signal.throwIfAborted()
  await t.step(async () => writeFile(join(personal, 'external-guide', 'SKILL.md'), '---\nname: external-guide\ndescription: External user-owned guide.\n---\nPACKED_PERSONAL_BODY\n'))
  t.signal.throwIfAborted()
  let step = 0, reviewStarted = false, observedQueuedReview = false
  const reviewClaim = Promise.withResolvers()
  t.signal.addEventListener('abort', () => reviewClaim.resolve(), { once: true })
  const h = await (t.step(async () => resources.host = nativeTaskHost(work, async (request, host) => {
    t.signal.throwIfAborted()
    assert.deepEqual(host.toolResults.filter(item => item.result.isError), [], 'The finite package script must not retry a rejected tool indefinitely')
    const input = latestInput(request), names = request.tools.map(tool => tool.name)
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    if (names.includes('task_delegate')) {
      if (input.executions.some(item => !item.drained || ['queued', 'running'].includes(item.status))) {
        if (input.executions.length === 3 && input.executions.some(item => item.status === 'queued' && item.drained)) observedQueuedReview = true
        return [finish('wait')]
      }
      for (const execution of input.executions) assert.equal(execution.status, 'succeeded', 'Drained failed executions are not a completed package task')
      if (input.executions.length && !reviewStarted) {
        reviewStarted = true
        return [call('task_delegate', { key: 'metadata-review', objective: 'Review guide metadata' }),
          call('task_delegate', { key: 'delivery-review', objective: 'Review original guide result' }), finish('wait')]
      }
      if (input.executions.length === 3) return [finish('complete')]
      assert.ok(JSON.stringify(request).includes('External user-owned guide.'))
      return [call('task_delegate', { key: 'packed-guide', objective: 'Read the external guide', skillNames: ['external-guide'] }), finish('wait')]
    }
    if (input.objective === 'Review guide metadata') {
      if (!JSON.stringify(request.messages).includes('PACKED_PERSONAL_BODY')) return [call('read', { file_path: join(personal, 'external-guide', 'SKILL.md') })]
      assert.match(JSON.stringify(request.messages), /name: external-guide/)
      return [call('execution_submit', { output: { status: 'completed', summary: 'Confirmed actual guide metadata.', evidence: ['external-guide/SKILL.md'], limitations: [], artifacts: [] } })]
    }
    if (input.objective === 'Review original guide result') {
      const projected = modelToolValues(request).findLast(item => item.executions || item.contextReadRequired)
      let team
      try { team = projected && resolveContextInput(request, projected) }
      catch (error) { if (error.contextReads) return error.contextReads.map(args => call('model_content_read', args)); throw error }
      if (!team) return [call('execution_team_read', {})]
      assert.ok(team.executions.find(item => item.objective === 'Read the external guide')?.result)
      return [call('execution_submit', { output: { status: 'completed', summary: 'Confirmed original guide result.', evidence: [], limitations: [], artifacts: [] } })]
    }
    if (step++ === 0) return [call('skill', { name: 'external-guide' })]
    assert.ok(JSON.stringify(request).includes('PACKED_PERSONAL_BODY'))
    return [call('execution_submit', { output: { status: 'completed', summary: 'Read actual external skill.', evidence: [], limitations: [], artifacts: [] } })]
  }, { skillDirs: [personal], serviceFactory: async options => {
    const { openDynamicTaskStore } = await import(pathToFileURL(join(f.dir, 'dynamic-task-store.js')).href)
    const backing = resources.store = await openDynamicTaskStore(options.config)
    // Keep a real queued/drained review visible until the Owner acknowledges
    // that it must wait. Only delay its claim; all writes/results stay native.
    return service.openTaskSessionService({ ...options, store: { ...backing, async command(command) {
      if (command.kind === 'execution.claim') {
        const execution = await backing.query({ kind: 'execution.get', executionId: command.args.executionId })
        if (execution.input.objective === 'Review original guide result') await reviewClaim.promise
      }
      const receipt = await backing.command(command)
      if (command.kind === 'task.wait' && observedQueuedReview) reviewClaim.resolve()
      return receipt
    } } })
  } })))
  f.stage('native-host-ready')
  t.signal.throwIfAborted()
  await t.step(async () => h.service.ingest({ groupId: 'native-group', messageId: 'packed-skill', senderOpenDingTalkId: 'native-user', text: '测试助手，Read my external guide.', occurredAt: '2026-10-13T17:00:00Z', timestamp: '2026-10-13T17:00:00Z' }))
  f.stage('message-ingested')
  await t.step(async () => h.service.whenIdle())
  t.signal.throwIfAborted()
  f.stage('native-task-idle')
  assert.equal((await t.step(async () => h.query('task.list')))[0].status, 'completed')
  assert.equal((await t.step(async () => h.query('task.list')))[0].topicRefs.length, 1)
  assert.equal(h.residentStore.listTopics('native-group').length, 1)
  assert.deepEqual(await t.step(async () => h.query('operation.list')), [])
  assert.equal((await t.step(async () => h.query('execution.list'))).length, 3)
  assert.equal(observedQueuedReview, true, 'The Owner must wait for the actual queued/drained review before completing')
  assert.ok((await t.step(async () => h.query('execution.list'))).every(item => item.status === 'succeeded' && item.drained))
  assert.deepEqual(h.toolResults.filter(item => item.result.isError), [])
  assert.deepEqual((await t.step(async () => h.service.recover())).failures, [])
  f.stage('native-task-verified')
})

test('actual extracted resident starts and serves health without legacy entrypoints or personal assets', async (t, resources) => {
  await t.beginBusiness()
  const f = await t.step(async () => pack(t, resources)), resident = await t.step(async () => import(pathToFileURL(join(f.dir, 'resident.js')).href))
  const work = join(f.root, 'runtime'); await t.step(async () => mkdir(work))
  t.signal.throwIfAborted()
  const h = await (t.step(async () => resources.host = nativeTaskHost(work, () => { throw new Error('Startup must not call a model') }, { resident: true })))
  f.stage('resident-host-ready')
  t.signal.throwIfAborted()
  const probe = createServer(), listening = once(probe, 'listening', { signal: t.signal })
  probe.listen({ port: 0, host: '127.0.0.1', signal: t.signal }); await t.step(async () => listening)
  const port = probe.address().port; await t.step(async () => new Promise(resolve => probe.close(resolve)))
  t.signal.throwIfAborted()
  const env = Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','NO_PROXY','no_proxy'].map(key => [key, process.env[key]]))
  resources.restoreEnv = () => { for (const [key,value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value }
  resources.fiber = h.ctx.plugin(resident, { host: '127.0.0.1', port, proxyUrl: '', agentWorkspaceDir: work, agentPreset: 'native-test',
    dws: { enabled: false }, taskSessions: { dbPath: join(work, 'resident.db'), instanceId: 'packed-runtime', initialize: true,
      ownerActorId: 'native-user', webActorId: 'native-user', ingressEpoch: '2026-10-13T00:00:00Z', recoveryIntervalMs: 60000 } })
  await t.step(async () => resources.fiber)
  t.signal.throwIfAborted()
  f.stage('resident-listening')
  const health = await t.step(async () => new Promise((resolve,reject) => get(`http://127.0.0.1:${port}/health`, { agent: false, signal: t.signal }, response => {
    let text = ''; response.on('data', chunk => { text += chunk }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }))
  }).on('error', reject)))
  assert.equal(health.status, 200); assert.equal(health.body.status, 'ok')
  assert.equal(h.requests.length, 0)
  for (const name of ['workflow', 'execution', 'goal']) assert.equal(h.ctx.get(name), undefined)
  f.stage('resident-health-verified')
})
