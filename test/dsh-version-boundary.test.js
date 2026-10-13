import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'

const version = '0.2.1-alpha.2'
const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('all shipped manifests and resolved DSH peers share the explicit alpha2 boundary', async () => {
  for (const path of ['package.json', 'packages/dingtalk-dsh-assistant/package.json',
    'packages/dingtalk-dsh-observer/package.json', '.dsh/profiles/resident/package.json', '.dsh/profiles/web/package.json']) {
    const manifest = JSON.parse(await read(path))
    for (const [name, installed] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (name.startsWith('@deepseek-ai/dsh')) assert.equal(installed, version, `${path}: ${name}`)
      assert.ok(!['@deepseek-ai/dsh-code-runtime', '@deepseek-ai/dsh-invariants', '@deepseek-ai/dsh-agent-presets',
        '@deepseek-ai/dsh-subagent-in-process-driver'].includes(name), `${path}: removed dependency ${name}`)
    }
  }
  const lock = yaml.load(await read('pnpm-lock.yaml'))
  const entries = Object.keys(lock.packages).filter(name => name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(entries.length > 0)
  for (const name of entries) assert.ok(name.endsWith('@' + version), `mixed host service dependency: ${name}`)
})

test('resident composes explicit presets and workspace while Web pins its actual host bundles', async () => {
  const resident = JSON.parse(await read('.dsh/profiles/resident/package.json'))
  for (const name of ['agent-preset', 'agent-preset-registry', 'workspace']) assert.equal(resident.dependencies['@deepseek-ai/dsh-' + name], version)
  const patch = await read('.dsh/profiles/resident/cordis.patch.yml')
  assert.match(patch, /id: agent-preset-registry[\s\S]*?default: standard/)
  assert.match(patch, /id: preset-standard[\s\S]*?id: standard\s+plugins: \[\]/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-workspace'/)
  const web = JSON.parse(await read('.dsh/profiles/web/package.json'))
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) assert.equal(web.dependencies[name], version)
})
