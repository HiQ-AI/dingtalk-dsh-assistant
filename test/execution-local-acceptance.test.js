import test from 'node:test'
import { assert, mkdtemp, mkdir, writeFile, readFile, rm, lstat, tmpdir, join, dirname, basename, resolve, execFile, promisify, createHash, freezeCandidate, createLocalAcceptanceRunner, acceptanceProcessTree, acceptanceProcessesAlive, exec, windows, fixtureScript, setup } from './fixtures/execution-local-acceptance-mixed.js'

test('任务验收拒绝tmp和evidence祖先junction，外部零写入且无执行预约', windows, async t => {
 const { symlink, readdir } = await import('node:fs/promises')
 for (const area of ['tmp', 'evidence']) {
  const fixture = await setup(t, {}, false, true), outside = join(fixture.directory, 'outside')
  await mkdir(outside)
  const target = area === 'tmp' ? fixture.options.tempRoot : join(dirname(fixture.prepared.directory), 'evidence')
  await symlink(outside, target, 'junction')
  await assert.rejects(fixture.runner.execute(fixture.prepared), /TASK_DIRECTORY_OUTSIDE_ROOT/)
  assert.deepEqual(await readdir(outside), [])
  await assert.rejects(readFile(join(dirname(fixture.prepared.directory), 'execution-reserved.json')), { code: 'ENOENT' })
 }
})

test('新任务验收runner及依赖跨LF/CRLF打包身份一致，真实源码变化仍改变身份', async t => {
 const { pathToFileURL } = await import('node:url')
 // Identity construction is platform-neutral; it must not prepare or run a
 // Windows acceptance process merely to compare source bytes.
 const directoryRoot = await mkdtemp(join(tmpdir(), 'local-acceptance-identity-')), identities = []
 t.after(() => rm(directoryRoot, { recursive: true, force: true }))
 const command = { executable: process.execPath, args: ['fixture.mjs'] }
 const fixture = { directory: directoryRoot, options: { root: join(directoryRoot, 'runs'), config: {
  version: 'identity-fixture', sharedDataProfilePath: join(directoryRoot, 'profile.json'), prepareSteps: [command],
  service: { ...command, args: ['fixture.mjs', '127.0.0.1', '{port}'], readyPath: '/ready' },
  scenarios: [{ ...command, id: 'fixture', description: 'source identity only' }], cleanup: command, verifyCleanup: command,
 } } }
 const files = ['execution-task-local-acceptance.js', 'execution-local-acceptance.js', 'execution-artifacts.js', 'execution-candidate.js', 'session-workspaces.js',
  'observer-artifact-pages.js', 'artifact-json.js', 'node-output-readout.js', 'workflow-notifications.js', 'group-message.js', 'execution-check-job.js']
 for (const style of ['lf', 'crlf', 'changed']) {
  const directory = join(fixture.directory, style); await mkdir(directory)
  await writeFile(join(directory, 'package.json'), '{"type":"module"}')
  for (const file of files) {
   let source = (await readFile(new URL('../packages/dingtalk-dsh-assistant/' + file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
   if (style === 'crlf') source = source.replace(/\n/g, '\r\n')
   if (style === 'changed' && file === 'execution-task-local-acceptance.js') source += '\n// deliberate implementation change\n'
   await writeFile(join(directory, file), source)
  }
  const { createTaskLocalAcceptanceRunner } = await import(pathToFileURL(join(directory, files[0])).href)
  identities.push(createTaskLocalAcceptanceRunner({ ...fixture.options, tempRoot: join(fixture.directory, 'tmp') }).identity)
 }
 assert.equal(identities[0], identities[1]); assert.notEqual(identities[0], identities[2])
})
