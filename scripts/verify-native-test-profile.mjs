import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('../test/fixtures/native-profile/package.json', import.meta.url))
assert.equal(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? fixture), resolve(fixture), 'Use only the isolated repository test profile')
const profiles = [
  { path: fixture, name: 'dingtalk-dsh-native-test-profile', version: '0.2.1-alpha.2' },
  { path: fileURLToPath(new URL('../test/fixtures/native-rc2-profile/package.json', import.meta.url)), name: 'dingtalk-dsh-native-rc2-test-profile', version: '0.2.1-rc.2' },
]
for (const { path: fixture, name, version } of profiles) {
  const manifest = JSON.parse(await readFile(fixture, 'utf8'))
  assert.equal(manifest.name, name)
  assert.equal(manifest.private, true)
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-base'], version)
  for (const [dependency, declared] of Object.entries(manifest.dependencies)) if (dependency.startsWith('@deepseek-ai/dsh-')) assert.equal(declared, version, dependency)
  assert.equal(manifest.dsh, undefined, 'The fixture must not load a user bundle or provider configuration')
  const profile = createRequire(fixture)
  profile.resolve('@deepseek-ai/cordis')
  profile.resolve('@deepseek-ai/cordis-plugin-loader')
  const native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
  assert.equal(JSON.parse(await readFile(native.resolve('@deepseek-ai/dsh-base/package.json'), 'utf8')).version, version)
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  const modules = ['agent', 'session', 'session-projection', 'system-prompt', 'llm', 'tools', 'user-approval',
    'jobs-local', 'tool-jobs', 'subprocess-local', 'sandbox-local', 'sandbox-policy', shell + '-sandbox',
    'permission-presets', 'session-title', 'session-persistence-jsonl', 'storage', 'storage-json', 'storage-domain',
    'workspace', 'agent-loop', 'agent-preset-registry', 'fs-local', 'working-directory', 'shell-env', 'tool-fs',
    'tool-' + shell, shell + '-local', 'fs-observation-policy', 'skill', 'skill-filesystem', 'tool-skill',
    'credentials-local', 'attachment-local', 'agent-default-model', 'api-session-controller', 'file-reference-local']
  const missing = modules.filter(name => { try { native.resolve('@deepseek-ai/dsh-' + name); return false } catch { return true } })
  assert.deepEqual(missing, [], 'Isolated native fixture is missing required public modules')
  const scheduleModules = ['schedule', 'tool-schedule']
  for (const name of scheduleModules) profile.resolve('@deepseek-ai/dsh-' + name)
  if (version === '0.2.1-rc.2') {
    const jobs = await readFile(native.resolve('@deepseek-ai/dsh-jobs-local'), 'utf8')
    assert.match(jobs, /session\.append\("job\/registered"/)
    assert.match(jobs, /session\.append\("job\/settled"/)
    assert.match(jobs, /producerReported/)
  }
  console.log(JSON.stringify({ nativeProfile: name, version, resolvedModules: modules.length + scheduleModules.length, credentialsLoaded: false }))
}
