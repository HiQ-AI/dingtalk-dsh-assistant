import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { inspectArtifacts, verifyArtifacts, assertCleanCheckout } from '../scripts/release-artifacts.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'release-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const packages = join(dir, 'artifacts'); await mkdir(packages)
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  const names = ['dingtalk-dsh-assistant', '@zzusp/dingtalk-dsh-assistant', '@zzusp/dingtalk-dsh-observer']
  for (const [index, name] of names.entries()) {
    const source = join(dir, 'source-' + index); await mkdir(join(source, 'package'), { recursive: true })
    await writeFile(join(source, 'package/package.json'), JSON.stringify({ name, version, ...(index === 0 ? { dependencies: Object.fromEntries(names.slice(1).map(x => [x, version])) } : {}) }))
    execFileSync('tar', ['-czf', join(packages, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`), '-C', source, 'package/package.json'], { windowsHide: true })
  }
  const identity = { sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), runId: '12345', tag: 'v' + version }
  const manifest = await inspectArtifacts(packages, identity)
  await writeFile(join(packages, 'release-manifest.json'), JSON.stringify(manifest))
  return { packages, identity, manifest }
}
test('three actual tgz and source identity round-trip; publish retry reuses identical bytes', async t => {
  const f = await fixture(t)
  assert.deepEqual(await verifyArtifacts(f.packages, f.identity), f.manifest)
  assert.deepEqual(await verifyArtifacts(f.packages, f.identity), f.manifest)
  assert.equal(f.manifest.files.length, 3)
  assert.ok(f.manifest.files.every(x => /^[0-9a-f]{64}$/.test(x.sha256) && /^[0-9a-f]{40}$/.test(x.sha1)))
})
test('different run/SHA/tag, lock/profile/environment and manifest hashes all fail closed', async t => {
  const f = await fixture(t)
  for (const [key, value] of Object.entries({ sha: 'a'.repeat(40), runId: '98765', tag: 'v999.0.0', lockSha256: 'b'.repeat(64), profileSha256: 'c'.repeat(64), node: 'v22.13.0', pnpm: '0', platform: 'foreign' })) {
    await writeFile(join(f.packages, 'release-manifest.json'), JSON.stringify({ ...f.manifest, [key]: value }))
    await assert.rejects(verifyArtifacts(f.packages, f.identity), /verified_release_artifact_mismatch/)
  }
  await writeFile(join(f.packages, 'release-manifest.json'), JSON.stringify(f.manifest))
  await assert.rejects(verifyArtifacts(f.packages, { ...f.identity, sha: 'a'.repeat(40) }), /release_checkout_sha_mismatch/)
  await assert.rejects(verifyArtifacts(f.packages, { ...f.identity, runId: '98765' }), /verified_release_artifact_mismatch/)
  const bad = structuredClone(f.manifest); bad.files[0].sha256 = '0'.repeat(64)
  await writeFile(join(f.packages, 'release-manifest.json'), JSON.stringify(bad))
  await assert.rejects(verifyArtifacts(f.packages, f.identity), /verified_release_artifact_mismatch/)
})
test('missing, extra and modified tarballs cannot reach publication', async t => {
  const f = await fixture(t), file = join(f.packages, f.manifest.files[0].file), bytes = await readFile(file)
  await unlink(file); await assert.rejects(verifyArtifacts(f.packages, f.identity), /release_package_set_mismatch/)
  await writeFile(file, bytes); await writeFile(join(f.packages, 'extra.tgz'), bytes)
  await assert.rejects(verifyArtifacts(f.packages, f.identity), /release_package_set_mismatch/)
  await unlink(join(f.packages, 'extra.tgz')); await writeFile(file, Buffer.concat([bytes, Buffer.from('changed')]))
  await assert.rejects(verifyArtifacts(f.packages, f.identity))
})
test('dirty tracked source and untracked package content cannot claim a commit identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'release-clean-tree-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' })
  git('init'); git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(dir, 'package.json'), '{}'); git('add', '.'); git('commit', '-m', 'fixture')
  assertCleanCheckout(dir)
  await writeFile(join(dir, 'package.json'), '{"changed":true}')
  assert.throws(() => assertCleanCheckout(dir), /release_source_dirty/)
  git('checkout', '--', 'package.json'); await mkdir(join(dir, 'packages'))
  await writeFile(join(dir, 'packages', 'foreign.js'), 'foreign')
  assert.throws(() => assertCleanCheckout(dir), /release_untracked_package_source/)
})
