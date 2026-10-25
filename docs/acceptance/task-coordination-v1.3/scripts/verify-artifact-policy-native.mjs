import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdir, readFile, lstat } from 'node:fs/promises'

const [profileManifest, policyEntry, root] = process.argv.slice(2)
if (!profileManifest || !policyEntry || !root) throw new Error('profile, policy entry and test root required')
const require = createRequire(resolve(profileManifest))
const native = createRequire(require.resolve('@deepseek-ai/dsh-base'))
const { Context } = require('@deepseek-ai/cordis')
const ctx = new Context()
const load = async (name, config) => ctx.plugin((await import(pathToFileURL(native.resolve('@deepseek-ai/dsh-' + name)).href)).default, config)
const artifactRoot = join(resolve(root), 'tasks', 'coordination-native', 'outputs')
const otherRoot = join(resolve(root), 'tasks', 'coordination-other', 'outputs')
await mkdir(artifactRoot, { recursive: true })
await mkdir(otherRoot, { recursive: true })
const targets = []
try {
  await load('session')
  await load('session-projection')
  await ctx.plugin((await import(pathToFileURL(resolve(policyEntry)).href)).default, { mode: 'workspace-write', workspaceRoot: resolve(root) })
  await load('fs-sandbox', { cwd: resolve(root) })
  await load('subprocess-local')
  await load('sandbox-local')
  await load('pwsh-sandbox', { cwd: resolve(root) })
  assert.ok(ctx.sandboxPolicy && ctx.fs && ctx.shell)
  const sessions = ['a', 'b', 'c'].map(id => ctx.sessions.create('artifact-native-' + id, { meta: { cwd: resolve(root) } }))
  for (const session of sessions) {
    const before = session.header.cwd
    ctx.sandboxPolicy.bindArtifactRoot(session, { ownerId: 'coordination-native', artifactRoot })
    ctx.sandboxPolicy.bindArtifactRoot(session, { ownerId: 'coordination-native', artifactRoot })
    assert.equal(session.header.cwd, before)
    assert.equal(ctx.sandboxPolicy.resolve({ session }).workspaceRoot, artifactRoot)
    assert.equal(session.seq, 1)
  }
  const policy = ctx.sandboxPolicy.resolve({ session: sessions[0] })
  const inside = join(artifactRoot, 'native-fs.txt')
  await ctx.fs.writeText(await ctx.fs.resolve(inside), 'native-fs', undefined, undefined, policy)
  assert.equal(await readFile(inside, 'utf8'), 'native-fs')
  targets.push(inside)
  await assert.rejects(ctx.fs.writeText(await ctx.fs.resolve(join(otherRoot, 'foreign.txt')), 'escape', undefined, undefined, policy), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(ctx.fs.writeText(await ctx.fs.resolve(join(root, 'old-cwd.txt')), 'escape', undefined, undefined, policy), { code: 'FS_SANDBOX_DENIED' })
  assert.throws(() => ctx.sandboxPolicy.bindArtifactRoot(sessions[0], { ownerId: 'coordination-other', artifactRoot: otherRoot }), /BINDING_CHANGED/)
  const session2Policy = ctx.sandboxPolicy.resolve({ session: sessions[1] })
  assert.equal(await ctx.fs.readText(await ctx.fs.resolve(inside)), 'native-fs')
  const shellFile = join(artifactRoot, 'native-shell.txt')
  const escaped = join(otherRoot, 'shell-escape.txt')
  const command = `$ErrorActionPreference='Stop'; Set-Content -LiteralPath '${shellFile.replaceAll("'", "''")}' -Value 'native-shell'; try { Set-Content -LiteralPath '${escaped.replaceAll("'", "''")}' -Value 'escape'; throw 'WRITE_ESCAPED' } catch { if ($_.Exception.Message -eq 'WRITE_ESCAPED') { throw }; Write-Output 'OUTSIDE_DENIED' }; Get-Content -LiteralPath '${inside.replaceAll("'", "''")}'`
  const spec = ctx.shell.resolve({ command, workdir: resolve(root), sandboxPolicy: session2Policy, timeoutMs: 20000 })
  const result = await (await ctx.shell.execute(spec)).result()
  assert.equal(result.exitCode, 0, JSON.stringify(result))
  assert.match(result.stdout.text, /OUTSIDE_DENIED/)
  assert.match(result.stdout.text, /native-fs/)
  assert.equal((await readFile(shellFile, 'utf8')).trim(), 'native-shell')
  assert.equal(await lstat(escaped).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)), false)
  assert.equal(ctx.sandboxPolicy.resolve({ session: sessions[2], mode: 'read-only' }).mode, 'read-only')
  assert.throws(() => ctx.sandboxPolicy.resolve({ session: sessions[2], mode: 'danger-full-access' }), /ARTIFACT_POLICY_MODE_REQUIRED/)
  console.log(JSON.stringify({ ok: true, artifactRoot, sessions: sessions.map(s => ({ id: s.id, cwd: s.header.cwd })), nativeFsInside: true, nativeFsOutsideDenied: true, nativeShellInside: true, nativeShellOutsideDenied: true, crossTaskRead: true, reboundDenied: true, rootFile: inside, shellFile }))
} finally {
  await ctx.fiber.dispose()
}
