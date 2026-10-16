import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('../test/fixtures/native-profile/package.json', import.meta.url))
assert.equal(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? fixture), resolve(fixture), 'Use only the isolated repository test profile')
const manifest = JSON.parse(await readFile(fixture, 'utf8'))
assert.equal(manifest.name, 'dingtalk-dsh-native-test-profile')
assert.equal(manifest.private, true)
assert.equal(manifest.dependencies['@deepseek-ai/dsh-base'], '0.2.1-alpha.2')
assert.equal(manifest.dsh, undefined, 'The fixture must not load a user bundle or provider configuration')
const profile = createRequire(fixture)
profile.resolve('@deepseek-ai/cordis')
profile.resolve('@deepseek-ai/cordis-plugin-loader')
const native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const modules = ['agent', 'session', 'session-projection', 'system-prompt', 'llm', 'tools', 'user-approval',
  'jobs-local', 'tool-jobs', 'subprocess-local', 'sandbox-local', 'sandbox-policy', shell + '-sandbox',
  'permission-presets', 'session-title', 'session-persistence-jsonl', 'storage', 'storage-json', 'storage-domain',
  'workspace', 'agent-loop', 'agent-preset-registry', 'fs-local', 'working-directory', 'shell-env', 'tool-fs',
  'tool-' + shell, shell + '-local', 'fs-observation-policy', 'skill', 'skill-filesystem', 'tool-skill',
  'credentials-local', 'attachment-local', 'agent-default-model']
const missing = modules.filter(name => { try { native.resolve('@deepseek-ai/dsh-' + name); return false } catch { return true } })
assert.deepEqual(missing, [], 'Isolated native fixture is missing required public modules')
console.log(JSON.stringify({ nativeProfile: 'isolated-scripted-fixture', resolvedModules: modules.length, credentialsLoaded: false }))
