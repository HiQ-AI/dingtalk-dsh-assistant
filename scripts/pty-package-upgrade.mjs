import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { resolve, join, isAbsolute, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const expected = {
  '@deepseek-ai/dsh-subprocess-local': { version: '0.2.1-rc.2.pty.2', files: ['lib/index.js'] },
  'node-pty': { version: '1.2.0-beta.15.dsh.2', files: ['lib/windowsPtyAgent.js', 'lib/windowsTerminal.js', 'lib/unixTerminal.js'] },
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw Error(`PTY_UPGRADE_${code}`) }
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function inputs(profile, proposal) {
  if (!isAbsolute(profile) || !isAbsolute(proposal)) fail('ABSOLUTE_PATH_REQUIRED')
  const input = JSON.parse(readFileSync(proposal, 'utf8'))
  if (input.schemaVersion !== 1 || !sha(input.expectedPackageJsonSha256) || !Array.isArray(input.packages)
    || input.packages.length !== 2 || new Set(input.packages.map(p => p.name)).size !== 2) fail('PROPOSAL_INVALID')
  for (const item of input.packages) {
    const contract = expected[item.name]
    if (!contract || item.version !== contract.version || !isAbsolute(item.path ?? '') || !item.path.endsWith('.tgz') || !sha(item.sha256)) fail('PACKAGE_IDENTITY')
    if (hash(readFileSync(item.path)) !== item.sha256) fail('PACKAGE_HASH')
    const members = execFileSync('tar', ['-tf', item.path], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)
    const read = name => {
      if (members.filter(member => member === `package/${name}`).length !== 1) fail('PACKAGE_MEMBER')
      return execFileSync('tar', ['-xOf', item.path, `package/${name}`], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    }
    const meta = JSON.parse(read('package.json'))
    if (meta.name !== item.name || meta.version !== item.version) fail('PACKED_IDENTITY')
    if (item.name === '@deepseek-ai/dsh-subprocess-local' && meta.dependencies?.['node-pty'] !== expected['node-pty'].version) fail('DEPENDENCY_VERSION')
    if (!item.files || Object.keys(item.files).sort().join('|') !== [...contract.files].sort().join('|')) fail('REQUIRED_FILES')
    for (const file of contract.files) if (!sha(item.files[file]) || hash(read(file)) !== item.files[file]) fail('PACKED_FILE_HASH')
    if (hash(readFileSync(item.path)) !== item.sha256) fail('PACKAGE_CHANGED')
  }
  return input
}
export function upgradePty({ profile, proposal, mode = 'check' }) {
  if (!['check', 'apply', 'verify'].includes(mode)) fail('MODE_INVALID')
  const input = inputs(profile, proposal), manifestPath = join(profile, 'package.json')
  const original = readFileSync(manifestPath), manifest = JSON.parse(original)
  if (mode !== 'verify' && hash(original) !== input.expectedPackageJsonSha256) fail('MANIFEST_CAS')
  const overrides = Object.fromEntries(input.packages.map(item => [item.name, `file:${item.path.replaceAll('\\', '/')}`]))
  if (mode === 'verify') {
    for (const [name, spec] of Object.entries(overrides)) if (manifest.pnpm?.overrides?.[name] !== spec) fail('OVERRIDE_MISMATCH')
    // 从实际 base bundle 消费者定位 provider，再沿 provider 的依赖解析 node-pty。
    const rootRequire = createRequire(manifestPath)
    const baseEntry = rootRequire.resolve('@deepseek-ai/dsh-base')
    const providerEntry = createRequire(baseEntry).resolve('@deepseek-ai/dsh-subprocess-local')
    const providerRequire = createRequire(providerEntry)
    const paths = {
      '@deepseek-ai/dsh-subprocess-local': providerRequire.resolve('@deepseek-ai/dsh-subprocess-local/package.json'),
      'node-pty': providerRequire.resolve('node-pty/package.json'),
    }
    const installed = input.packages.map(item => {
      const packagePath = paths[item.name], meta = JSON.parse(readFileSync(packagePath))
      if (meta.name !== item.name || meta.version !== item.version) fail('INSTALLED_IDENTITY')
      for (const [file, digest] of Object.entries(item.files)) if (hash(readFileSync(join(dirname(packagePath), file))) !== digest) fail('INSTALLED_FILE_HASH')
      return { name: item.name, version: meta.version, packagePath, files: item.files, packageSha256: item.sha256 }
    })
    return { mode, baseEntry, providerEntry, manifestSha256: hash(original), installed }
  }
  const next = structuredClone(manifest)
  next.pnpm = { ...next.pnpm, overrides: { ...next.pnpm?.overrides, ...overrides } }
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n')
  if (mode === 'apply') {
    if (hash(readFileSync(manifestPath)) !== input.expectedPackageJsonSha256) fail('MANIFEST_CAS')
    const temporary = `${manifestPath}.pty-upgrade-${process.pid}.tmp`
    try {
      writeFileSync(temporary, bytes, { flag: 'wx' })
      if (hash(readFileSync(manifestPath)) !== input.expectedPackageJsonSha256) fail('MANIFEST_CAS')
      renameSync(temporary, manifestPath)
    } finally { try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
    if (hash(readFileSync(manifestPath)) !== hash(bytes)) fail('WRITE_READBACK')
  }
  return { mode, writes: mode === 'apply' ? 1 : 0, previousManifestSha256: hash(original), nextManifestSha256: hash(bytes), packages: input.packages }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, profile, proposal] = process.argv.slice(2)
  console.log(JSON.stringify(upgradePty({ mode, profile, proposal })))
}
