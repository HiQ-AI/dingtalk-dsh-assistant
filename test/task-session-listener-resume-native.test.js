import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { available, reason, nativeTaskHost } from './fixtures/task-session-native-host.js'
import { createTaskSessions } from '../packages/dingtalk-dsh-assistant/task-session.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'

for (const mode of ['file-reference', 'subagent', 'both']) test(`native owner repeated resume with live root async agent-created listeners: ${mode}`, { skip: !available ? reason : false, timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'owner-listener-resume-'))
  const h = await nativeTaskHost(root, async () => [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '保持原任务等待实际结果', evidence: [], limitations: [] } } }], { resident: true })
  const profile = createRequire(pathToFileURL(resolve(process.env.DSH_NATIVE_TEST_PROFILE ?? '.dsh/profiles/resident/package.json')))
  const native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
  async function mount(name, config = {}) {
    const module = await import(pathToFileURL(native.resolve('@deepseek-ai/dsh-' + name)).href)
    await h.ctx.plugin(module.default ?? module, config)
  }
  await mount('fs-local', { cwd: root }); await mount('working-directory', { defaultDirectory: root })
  if (mode !== 'subagent') { await mount('file-reference-local'); assert.ok(h.ctx.get('fileReferences')) }
  if (mode !== 'file-reference') {
    await mount('subagent'); await mount('subagent-spawn-in-process', { providerName: 'spawn' })
    await mount('tool-subagent/model-selection-settings', { enabled: true, allowedModels: [{ provider: 'native-task-test', model: 'controlled' }] })
    await h.ctx.agentPresets.register({ id: 'listener-test', plugins: [{ name: pathToFileURL(native.resolve('@deepseek-ai/dsh-tool-subagent')).href,
      config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true } }] })
    assert.ok(h.ctx.get('subagents'))
  }
  const cwd = join(root, 'tasks', 'task-listener'); await mkdir(cwd, { recursive: true })
  const manager = createTaskSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => cwd })
  t.after(async () => { try { await manager.close(); await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  let bound = 0, submits = 0
  for (let leaseEpoch = 1; leaseEpoch <= 4; leaseEpoch++) {
    const result = await manager.run({ binding: { kind: 'task-session', taskId: 'task-listener', sessionId: 'listener-owner', leaseEpoch, sessionBound: leaseEpoch > 1 },
      provider: 'native-task-test', model: 'controlled', agentPreset: mode === 'file-reference' ? 'native-test' : 'listener-test', input: { task: { title: '原任务', objective: '保持原身份继续', requirementRevision: 1 }, wakes: [] },
      onSessionBound: async () => { bound++ }, submit: async () => { submits++; return { accepted: true } } })
    assert.equal(result.status, 'submitted')
  }
  assert.equal(bound, 4); assert.equal(submits, 4)
  const log = await inspectSession(h.ctx.sessionPersistence, 'listener-owner')
  assert.equal(log.events.filter(event => event.type === 'plugin:dingtalk/task-session').length, 1)
  assert.equal(h.requests.length, 4)
})
