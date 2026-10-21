import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')
const packages = ['dingtalk-dsh-assistant', '@zzusp/dingtalk-dsh-assistant', '@zzusp/dingtalk-dsh-observer']
const filename = (name, version) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
export function assertCleanCheckout(directory = root) {
  const tracked = spawnSync('git', ['diff', '--quiet', 'HEAD'], { cwd: directory, windowsHide: true })
  if (tracked.status !== 0) throw Error('release_source_dirty')
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'packages', 'index.js', 'package.json', 'README.md', 'CHANGELOG.md', 'cordis.patch.yml'], { cwd: directory, encoding: 'utf8', windowsHide: true }).trim()
  if (untracked) throw Error('release_untracked_package_source')
}
export async function inspectArtifacts(directory, identity) {
  if (!/^[0-9a-f]{40}$/.test(identity.sha) || !/^\d+$/.test(identity.runId) || !identity.tag.startsWith('v')) throw Error('release_identity_invalid')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  if (head !== identity.sha) throw Error('release_checkout_sha_mismatch')
  const manifests = await Promise.all(['package.json', 'packages/dingtalk-dsh-assistant/package.json', 'packages/dingtalk-dsh-observer/package.json'].map(async p => JSON.parse(await readFile(resolve(root, p), 'utf8'))))
  const version = identity.tag.slice(1)
  if (!/^\d+\.\d+\.\d+$/.test(version) || manifests.some((m, i) => m.version !== version || m.name !== packages[i])) throw Error('release_manifest_version_mismatch')
  if (process.version !== 'v24.19.0') throw Error('release_node_version_mismatch')
  const expected = packages.map(name => filename(name, version)).sort()
  const actual = (await readdir(directory)).filter(x => x !== 'release-manifest.json').sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('release_package_set_mismatch')
  const files = []
  for (const name of packages) {
    const file = filename(name, version), path = resolve(directory, file), bytes = await readFile(path)
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8', windowsHide: true }))
    const entries = execFileSync('tar', ['-tf', path], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)
    if (manifest.name !== name || manifest.version !== version || entries.some(x => !x.startsWith('package/') || x.includes('..') || /(?:node_modules|\.git|\.env|AGENTS\.md|docs\/acceptance)(?:\/|$)/.test(x))) throw Error(`release_tarball_invalid_${file}`)
    if (name === packages[0] && packages.slice(1).some(child => manifest.dependencies?.[child] !== version)) throw Error('release_root_dependency_mismatch')
    files.push({ name, file, version, size: bytes.length, sha256: hash(bytes), sha1: hash(bytes, 'sha1') })
  }
  return { schema: 1, ...identity, node: process.version, platform: process.platform, pnpm: '10.13.1',
    lockSha256: hash(await readFile(resolve(root, 'pnpm-lock.yaml'))),
    profileSha256: hash(await readFile(resolve(root, 'test/fixtures/native-profile/package.json'))), files }
}
export async function verifyArtifacts(directory, identity) {
  const saved = JSON.parse(await readFile(resolve(directory, 'release-manifest.json'), 'utf8'))
  const actual = await inspectArtifacts(directory, identity)
  if (JSON.stringify(saved) !== JSON.stringify(actual)) throw Error('verified_release_artifact_mismatch')
  return actual
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory = 'docs/tmp/packages'] = process.argv.slice(2)
  const identity = { sha: process.env.RELEASE_SHA, runId: process.env.GITHUB_RUN_ID, tag: process.env.RELEASE_TAG }
  if (command === 'create' || command === 'verify') assertCleanCheckout()
  if (command === 'create') {
    const pnpm = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8', windowsHide: true })
    if (pnpm.status !== 0 || pnpm.stdout.trim() !== '10.13.1') throw Error('release_pnpm_version_mismatch')
  }
  const data = command === 'create' ? await inspectArtifacts(resolve(directory), identity) : command === 'verify' ? await verifyArtifacts(resolve(directory), identity) : null
  if (!data) throw Error('unknown_release_artifact_command')
  if (command === 'create') await writeFile(resolve(directory, 'release-manifest.json'), JSON.stringify(data, null, 2) + '\n')
  console.log(JSON.stringify(data))
}
