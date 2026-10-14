import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const source = fileURLToPath(new URL('../packages/dingtalk-dsh-assistant/', import.meta.url))

// Offline installation of the exact npm payload into a real profile node_modules
// directory. Only already-installed third-party dependencies are linked. No npm
// install resolver, lifecycle scripts, registry requests, or existing profile edits.
test('installed profile resolves and imports the final packed resident without source fallback', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'installed-profile-entry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let npm
  for (const candidate of [process.env.npm_execpath, join(dirname(process.execPath), 'npm'),
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)) {
    const found = await realpath(candidate).catch(() => null)
    if (found?.endsWith('npm-cli.js')) { npm = found; break }
  }
  assert.ok(npm, 'An already installed npm CLI is required')
  const { stdout } = await exec(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--offline',
    '--pack-destination', root, '--cache', join(root, 'cache')], { cwd: source })
  const [manifest] = JSON.parse(stdout)
  const profile = join(root, 'profile'), installed = join(profile, 'node_modules', '@zzusp', 'dingtalk-dsh-assistant')
  await mkdir(installed, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-profile', private: true, type: 'module' }))
  await exec('tar', ['-xzf', join(root, manifest.filename), '--strip-components=1', '-C', installed])
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  const installedReal = await realpath(installed), sourceReal = await realpath(source)
  assert.notEqual(installedReal, sourceReal, 'Runtime must be a separate installed payload')
  const dependencyResolver = createRequire(join(source, 'package.json'))
  for (const name of Object.keys(pkg.dependencies)) {
    const target = await realpath(dirname(dependencyResolver.resolve(name + '/package.json')))
    const link = join(profile, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(target, link, 'junction')
  }
  const profileRequire = createRequire(join(profile, 'package.json'))
  const entry = profileRequire.resolve('@zzusp/dingtalk-dsh-assistant/resident')
  assert.equal(await realpath(entry), join(installedReal, 'resident.js'))
  assert.ok(!entry.startsWith(sourceReal), 'Profile entry cannot resolve the repository package')
  const names = new Set(manifest.files.map(file => file.path))
  for (const file of manifest.files.filter(file => file.path.endsWith('.js'))) {
    const filename = join(installed, file.path), content = await readFile(filename, 'utf8')
    // Static relative imports and exports must remain inside the published payload.
    for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(filename), match[1]), rel = relative(installed, target)
      assert.ok(!rel.startsWith('..'), `Packed module escapes installation: ${file.path} -> ${match[1]}`)
      assert.ok(names.has(rel), `Packed dependency missing: ${file.path} -> ${match[1]}`)
      await readFile(target)
    }
  }
  const resident = await import(pathToFileURL(entry).href)
  assert.equal(typeof resident.apply, 'function')
  assert.ok(Array.isArray(resident.inject))
  assert.equal((await import(pathToFileURL(profileRequire.resolve('@zzusp/dingtalk-dsh-assistant')).href)).name,
    'dingtalk-dsh-assistant-web')
})
