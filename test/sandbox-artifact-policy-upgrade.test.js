import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { upgradeArtifactPolicy, artifactPolicySource } from '../scripts/sandbox-artifact-policy.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'profile'), stage = join(root, 'stage', 'package')
  await mkdir(profile)
  await mkdir(join(stage, 'lib'), { recursive: true })
  const original = JSON.stringify({ dependencies: { host: 'fixed' }, pnpm: { overrides: { untouched: 'old' } } }) + '\n'
  await writeFile(join(profile, 'package.json'), original)
  const code = 'export const fixture = true\n'
  await writeFile(join(stage, 'lib/index.js'), code)
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-sandbox-policy',
    version: '0.2.1-rc.2.artifact.2', dsh: { originalEntrySha256: '772ca58f0f786d6cb4d839deb621634c31097c13228d81b14e3f3153d0524924' } }))
  const packagePath = join(root, 'policy.tgz')
  execFileSync('tar', ['-czf', packagePath, '-C', join(root, 'stage'), 'package'], { windowsHide: true })
  const input = { schemaVersion: 1, name: '@deepseek-ai/dsh-sandbox-policy', version: '0.2.1-rc.2.artifact.2',
    expectedManifestSha256: sha(original), packagePath, packageSha256: sha(await readFile(packagePath)), entrySha256: sha(code) }
  const proposal = join(root, 'proposal.json')
  await writeFile(proposal, JSON.stringify(input))
  return { root, profile, proposal, input, original }
}

test('policy proposal check writes nothing and apply changes only its exact override', async t => {
  const f = await fixture(t)
  const check = upgradeArtifactPolicy({ ...f, mode: 'check' })
  assert.equal(check.writes, 0)
  assert.equal(await readFile(join(f.profile, 'package.json'), 'utf8'), f.original)
  const applied = upgradeArtifactPolicy({ ...f, mode: 'apply' })
  assert.equal(applied.writes, 1)
  const actual = JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8'))
  assert.equal(actual.dependencies.host, 'fixed')
  assert.equal(actual.dependencies['@deepseek-ai/dsh-sandbox-policy'], `file:${f.input.packagePath.replaceAll('\\', '/')}`)
  assert.equal(actual.pnpm.overrides.untouched, 'old')
  assert.equal(actual.pnpm.overrides['@deepseek-ai/dsh-sandbox-policy'], `file:${f.input.packagePath.replaceAll('\\', '/')}`)
  assert.throws(() => upgradeArtifactPolicy({ ...f, mode: 'apply' }), /MANIFEST_CAS/)
})

test('changed manifest, archive or declared entry digest fails before profile write', async t => {
  const f = await fixture(t)
  await writeFile(join(f.profile, 'package.json'), f.original + ' ')
  assert.throws(() => upgradeArtifactPolicy({ ...f, mode: 'check' }), /MANIFEST_CAS/)
  await writeFile(join(f.profile, 'package.json'), f.original)
  await writeFile(f.proposal, JSON.stringify({ ...f.input, entrySha256: '0'.repeat(64) }))
  assert.throws(() => upgradeArtifactPolicy({ ...f, mode: 'check' }), /PACKED_IDENTITY/)
  await writeFile(f.proposal, JSON.stringify(f.input))
  await writeFile(f.input.packagePath, 'changed')
  assert.throws(() => upgradeArtifactPolicy({ ...f, mode: 'check' }), /PACKAGE_HASH/)
  assert.equal(await readFile(join(f.profile, 'package.json'), 'utf8'), f.original)
})

test('native source recipe refuses an unreviewed source revision', () => {
  assert.throws(() => artifactPolicySource(Buffer.from('changed source')), /SOURCE_HASH/)
})
