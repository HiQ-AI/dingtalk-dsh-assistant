import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { openTaskSessionHistory } from '../packages/dingtalk-dsh-assistant/task-session-history.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { nativeTaskHost, latestInput, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { createModelContentIndex } from '../packages/dingtalk-dsh-assistant/model-context.js'
import { canonicalExecutionJson } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openDynamicTaskStore } from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function temporary() {
  const base = resolve('.test-runs/task-session-material-history'); await mkdir(base, { recursive: true })
  return mkdtemp(join(base, 'run-'))
}
async function snapshot(root) {
  const files = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const path = join(entry.parentPath, entry.name)
    files.push([path.slice(root.length), digest(await readFile(path))])
  }
  return files.sort((a, b) => a[0].localeCompare(b[0]))
}
async function historicalFixture() {
  const root = await temporary(), archive = join(root, 'archive'), artifactDirectory = join(archive, 'artifacts'), workspace = join(archive, 'workspace')
  await mkdir(artifactDirectory, { recursive: true }); await mkdir(workspace)
  async function artifact(value, taskId) {
    const bytes = Buffer.from(canonicalExecutionJson(value)), fileName = `sha256-${digest(bytes)}.json`
    const directory = taskId ? join(workspace, 'tasks', taskId, 'work', 'artifacts') : artifactDirectory
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, fileName), bytes)
    return taskId ? `tasks/${taskId}/${fileName}` : fileName
  }
  const requirement = await artifact({ request: '保留历史任务目标与结果', constraints: ['不能重跑历史写入'] })
  const evidence = await artifact({ kind: 'verified-native-evidence', command: 'verify.sh', result: '真实历史检查通过' }, 'legacy-task')
  const output = await artifact({ status: 'completed', summary: '历史执行的完整结果', evidenceRefs: [evidence] })
  const codeOutput = await artifact({ summary: '没有会话的代码步骤结果也保留', checked: true })
  const dbPath = join(archive, 'old.sqlite'), db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE business_tasks(task_id TEXT PRIMARY KEY,requirement_ref TEXT,status TEXT,requirement_revision INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE task_owners(task_id TEXT PRIMARY KEY,session_id TEXT,session_bound INTEGER);
    CREATE TABLE task_controls(task_id TEXT PRIMARY KEY,state TEXT,control_revision INTEGER);
    CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY,task_id TEXT,status TEXT,requirement_ref TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE execution_nodes(node_run_id TEXT,run_id TEXT,session_id TEXT,status TEXT,drained INTEGER,output_ref TEXT,evidence_refs TEXT);
    CREATE TABLE task_reports(report_id TEXT,task_id TEXT,report_type TEXT,facts_json TEXT,created_at TEXT);
    CREATE TABLE task_events(seq INTEGER,task_id TEXT,event_type TEXT,payload_ref TEXT,created_at TEXT);
    CREATE TABLE task_plan_stages(task_id TEXT,stage_id TEXT,status TEXT);`)
  db.prepare('INSERT INTO business_tasks VALUES(?,?,?,?,?,?)').run('legacy-task', requirement, 'succeeded', 3, 'old-created', 'old-updated')
  db.prepare('INSERT INTO task_owners VALUES(?,?,?)').run('legacy-task', 'legacy-session', 1)
  db.prepare('INSERT INTO task_controls VALUES(?,?,?)').run('legacy-task', 'active', 2)
  db.prepare('INSERT INTO execution_runs VALUES(?,?,?,?,?,?)').run('old-run', 'legacy-task', 'succeeded', requirement, 'old-created', 'old-updated')
  db.prepare('INSERT INTO execution_nodes VALUES(?,?,?,?,?,?,?)').run('old-node', 'old-run', 'old-execution-session', 'succeeded', 1, output, JSON.stringify([evidence]))
  db.prepare('INSERT INTO execution_nodes VALUES(?,?,?,?,?,?,?)').run('old-code-node', 'old-run', null, 'succeeded', 1, codeOutput, '[]')
  db.prepare('INSERT INTO task_reports VALUES(?,?,?,?,?)').run('old-progress', 'legacy-task', 'wait', JSON.stringify({ summary: '之前等待检查' }), 'old-wait')
  db.prepare('INSERT INTO task_reports VALUES(?,?,?,?,?)').run('old-final', 'legacy-task', 'complete', JSON.stringify({ summary: '已完成，保留原始结论', evidenceRefs: [evidence], limitations: ['仅历史记录'] }), 'old-complete')
  db.prepare('INSERT INTO task_events VALUES(?,?,?,?,?)').run(1, 'legacy-task', 'execution.recorded', evidence, 'old-event')
  db.prepare('INSERT INTO task_plan_stages VALUES(?,?,?)').run('legacy-task', 'retired-stage', 'completed')
  db.close()
  return { root, archive, dbPath, artifactDirectory, workspace, refs: { requirement, evidence, output, codeOutput } }
}

async function service(root, options = {}) {
  const inputs = []
  let host
  host = await nativeTaskHost(root, request => {
    const topicCalls = topicTaskCalls(request)
    if (topicCalls) return topicCalls
    const input = latestInput(request)
    if (input.materials?.contextPath) {
      const message = request.messages.find(message => message.source?.taskSession)
      const session = host.ctx.sessions.get(message.source.taskSession.sessionId)
      const index = createModelContentIndex(session)
      const page = index.read({ contentRef: input.contextRef, path: input.materials.contextPath, limit: 16000 })
      assert.equal(page.nextOffset, null)
      inputs.push({ ...input, materials: JSON.parse(page.text) })
    } else inputs.push(input)
    return [{ name: 'task_session_submit', args: { decision: { action: 'wait', summary: '材料已登记，等待后续执行', evidence: [], limitations: [] } } }]
  }, {
    initialize: options.initialize !== false,
    config: { dbPath: join(root, 'dynamic.sqlite'), instanceId: 'material-history', ownerActorId: 'user', ...options.config },
    serviceFactory: args => openTaskSessionService({ ...args, readResource: options.readResource }),
  })
  return { instance: { ...host.service, close: () => host.close() }, inputs, residentStore: host.residentStore }
}

test('historical conclusions and complete execution artifacts are readable without modifying any archived database or artifact bytes', async () => {
  const f = await historicalFixture(), before = await snapshot(f.archive)
  const history = openTaskSessionHistory(f.dbPath, { artifactDirectory: f.artifactDirectory, taskWorkspaceRoot: f.workspace })
  try {
    const task = await history.read('legacy-task')
    assert.equal(task.historyOnly, true); assert.equal(task.legacyReadonly, true)
    assert.equal(task.result.summary, '已完成，保留原始结论')
    assert.equal(task.reports.length, 2)
    assert.equal(task.requirement.value.request, '保留历史任务目标与结果')
    assert.equal(task.result.evidenceDetails[0].value.result, '真实历史检查通过')
    assert.equal(task.executions[0].sessions[0].output.value.summary, '历史执行的完整结果')
    assert.equal(task.executions[0].sessions[1].sessionId, null)
    assert.equal(task.executions[0].sessions[1].output.value.checked, true)
    assert.equal(task.historicalArtifacts.length, 4)
    assert.equal(history.list().length, 1)
    assert.equal(await history.read('absent'), null)
  } finally { history.close() }
  assert.deepEqual(await snapshot(f.archive), before)
})

test('active task service ignores archived history and never exposes or imports retired tasks', async () => {
  const f = await historicalFixture(), before = await snapshot(f.archive)
  const h = await service(f.root, { config: { legacyDbPath: f.dbPath, legacyArtifactDirectory: f.artifactDirectory, legacyWorkspaceDir: f.workspace } })
  try {
    assert.equal(await h.instance.taskDetail('legacy-task'), null)
    assert.deepEqual((await h.instance.taskExecutions('legacy-task')).executions, [])
    assert.deepEqual(await h.instance.store.query({ kind: 'task.list' }), [])
    assert.deepEqual(await h.instance.store.query({ kind: 'execution.list' }), [])
    assert.deepEqual(await h.instance.boardTasks(), [])
    assert.deepEqual(await h.instance.store.query({ kind: 'legacy.list' }), [])
    assert.equal(h.inputs.length, 0)
  } finally { await h.instance.close() }
  assert.deepEqual(await snapshot(f.archive), before)
})

test('missing configuration, corrupt contents and malformed historical refs are reported unavailable rather than invented evidence', async () => {
  const f = await historicalFixture()
  let history = openTaskSessionHistory(f.dbPath)
  try { assert.ok((await history.read('legacy-task')).historicalArtifacts.every(item => item.status === 'unavailable' && item.reason === 'LEGACY_ARTIFACT_ROOT_UNAVAILABLE')) }
  finally { history.close() }
  await writeFile(join(f.artifactDirectory, f.refs.output), '{"summary":"altered"}')
  const db = new DatabaseSync(f.dbPath)
  db.prepare('UPDATE execution_nodes SET evidence_refs=? WHERE node_run_id=?').run(JSON.stringify(['../outside.json', 'sha256-' + 'a'.repeat(64) + '.json']), 'old-node'); db.close()
  const before = await snapshot(f.archive)
  history = openTaskSessionHistory(f.dbPath, { artifactDirectory: f.artifactDirectory, taskWorkspaceRoot: f.workspace })
  try {
    const task = await history.read('legacy-task'), byRef = new Map(task.historicalArtifacts.map(item => [item.ref, item]))
    assert.equal(byRef.get(f.refs.output).reason, 'ARTIFACT_DIGEST_MISMATCH')
    assert.equal(byRef.get('../outside.json').reason, 'ARTIFACT_REFERENCE_INVALID')
    assert.equal(byRef.get('sha256-' + 'a'.repeat(64) + '.json').reason, 'ENOENT')
  } finally { history.close() }
  assert.deepEqual(await snapshot(f.archive), before)
})

test('source text and actual attachment bytes are materialized into their own task and reused without downloading again', async () => {
  const root = await temporary(), calls = []
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 0, 255])
  const h = await service(root, { readResource: async (groupId, messageId, resource) => {
    calls.push({ groupId, messageId, resource })
    return resource.resourceId === 'text' ? { text: '真实附件正文\nSELECT 1;', complete: true, mediaType: 'text/plain' }
      : { image: { data: imageBytes, mediaType: 'image/png', name: '../untrusted.png' } }
  } })
  try {
    const source = { groupId: 'native-group', messageId: 'one', senderOpenDingTalkId: 'user', occurredAt: '2026-10-13T10:00:00Z', mediaUnavailable: [], text: '测试助手，分析这份材料', resourceRefs: [{ type: 'fileId', resourceId: 'text' }, { type: 'mediaId', resourceId: 'image' }] }
    await h.instance.ingest(source); await h.instance.whenIdle()
    await h.instance.ingest({ ...source, messageId: 'two', text: '测试助手，这是第二个独立任务' }); await h.instance.whenIdle()
    const tasks = await h.instance.store.query({ kind: 'task.list' })
    assert.equal(tasks.length, 2); assert.equal(calls.length, 4)
    assert.equal(h.residentStore.listTopics('native-group').length, 2)
    assert.ok(tasks.every(task => task.topicRefs.length === 1))
    for (const task of tasks) {
      const directory = join(root, 'tasks', task.taskId, 'materials')
      const name = (await readdir(directory)).find(name => name.startsWith('source-'))
      const material = JSON.parse(await readFile(join(directory, name), 'utf8'))
      assert.equal(material.taskId, task.taskId)
      assert.equal(material.path, join(directory, name))
      assert.equal(material.resources.length, 2)
      for (const entry of material.resources) {
        assert.equal(entry.status, 'read'); assert.equal(entry.complete, true)
        assert.equal(entry.path.startsWith(directory + sep), true)
        const bytes = await readFile(entry.path)
        assert.equal(digest(bytes), entry.sha256)
        assert.equal(bytes.length, entry.bytes)
        if (entry.resource.resourceId === 'text') assert.equal(bytes.toString('utf8'), '真实附件正文\nSELECT 1;')
        else assert.deepEqual(bytes, Buffer.from(imageBytes))
      }
    }
    await h.instance.ingest(source); await h.instance.whenIdle()
    assert.equal(calls.length, 4)
    assert.ok(h.inputs.every(input => input.materials.every(material => material.resources.every(resource => resource.path.includes(sep + 'materials' + sep)))))
  } finally { await h.instance.close() }
})

for (const mode of ['throw', 'null', 'partial', 'metadata-only', 'unconfigured']) test(`resource ${mode} never becomes a successful material download`, async () => {
  const root = await temporary()
  const h = await service(root, { readResource: mode === 'unconfigured' ? undefined : async () => {
    if (mode === 'throw') throw Object.assign(new Error('connector detail must not be stored'), { code: 'CONNECTOR_UNAVAILABLE' })
    if (mode === 'null') return null
    if (mode === 'partial') return { text: 'only first page', complete: false }
    return { url: 'https://example.invalid/not-downloaded' }
  } })
  try {
    await h.instance.ingest({ groupId: 'native-group', messageId: mode, senderOpenDingTalkId: 'user', occurredAt: '2026-10-13T10:00:00Z', mediaUnavailable: [], text: '测试助手，读取材料', resourceRefs: [{ type: 'fileId', resourceId: 'missing' }] })
    await h.instance.whenIdle()
    const task = (await h.instance.store.query({ kind: 'task.list' }))[0]
    const directory = join(root, 'tasks', task.taskId, 'materials'), names = await readdir(directory)
    assert.equal(names.length, 1)
    const material = JSON.parse(await readFile(join(directory, names[0]), 'utf8')), resource = material.resources[0]
    assert.equal(resource.status, 'unavailable'); assert.ok(resource.reason)
    assert.equal(resource.path, undefined); assert.equal(resource.value, undefined)
    assert.equal(JSON.stringify(material).includes('connector detail'), false)
    assert.equal(h.inputs[0].materials[0].resources[0].status, 'unavailable')
  } finally { await h.instance.close() }
})

for (const mode of ['snapshot-link', 'snapshot-truncated', 'foreign-resource', 'resource-link', 'source-identity']) test(`cached material ${mode} is rejected before reaching any task model or connector`, async () => {
  const root = await temporary(); let reads = 0
  const h = await service(root, { config: { retryIntervalMs: 60000 }, readResource: async () => { reads++; return { text: 'original bytes', complete: true } } })
  try {
    await h.instance.ingest({ groupId: 'native-group', messageId: mode, senderOpenDingTalkId: 'user', occurredAt: '2026-10-13T10:00:00Z', mediaUnavailable: [], text: '测试助手，读取自己的材料', resourceRefs: [{ type: 'fileId', resourceId: 'own' }] })
    await h.instance.whenIdle()
    const task = (await h.instance.store.query({ kind: 'task.list' }))[0]
    const directory = join(root, 'tasks', task.taskId, 'materials'), name = (await readdir(directory)).find(name => name.startsWith('source-'))
    const path = join(directory, name), originalSnapshot = await readFile(path), material = JSON.parse(originalSnapshot.toString('utf8'))
    const foreign = join(root, 'tasks', 'foreign-task', 'materials'); await mkdir(foreign, { recursive: true })
    const foreignFile = join(foreign, 'private.txt'); await writeFile(foreignFile, 'FOREIGN_SECRET_MUST_NOT_REACH_MODEL')
    const modelCalls = h.inputs.length
    if (mode === 'snapshot-link') {
      const prior = join(root, 'external-snapshot.json'); await rename(path, prior)
      // Windows 无特权进程用原生 junction 覆盖最终路径重解析点拒绝；POSIX 保留文件 symlink。
      await symlink(process.platform === 'win32' ? foreign : prior, path, process.platform === 'win32' ? 'junction' : 'file')
    } else if (mode === 'snapshot-truncated') await writeFile(path, '{"sourceId":')
    else if (mode === 'foreign-resource') {
      material.resources[0].path = foreignFile
      material.resources[0].sha256 = digest(await readFile(foreignFile)); material.resources[0].bytes = (await readFile(foreignFile)).length
      await writeFile(path, JSON.stringify(material))
    } else if (mode === 'resource-link') {
      await rename(material.resources[0].path, join(root, 'saved-resource.txt'))
      await symlink(process.platform === 'win32' ? foreign : foreignFile, material.resources[0].path, process.platform === 'win32' ? 'junction' : 'file')
    } else {
      material.resources[0].resource.resourceId = 'another-users-resource'
      await writeFile(path, JSON.stringify(material))
    }
    await h.instance.store.command({ id: 'wake-cached-material', kind: 'task.revise', args: { taskId: task.taskId, expectedRequirementRevision: 1, request: task.request + '\n再次核对', sourceRefs: task.sourceRefs } })
    await h.instance.recover(); await h.instance.whenIdle()
    const observation = await h.instance.recover()
    assert.ok(observation.failures.some(failure => /^TASK_MATERIAL_/.test(failure.code)), JSON.stringify(observation))
    assert.equal(h.inputs.length, modelCalls)
    assert.equal(reads, 1)
    assert.equal(JSON.stringify(h.inputs).includes('FOREIGN_SECRET'), false)
    assert.equal(await readFile(foreignFile, 'utf8'), 'FOREIGN_SECRET_MUST_NOT_REACH_MODEL')
    assert.deepEqual(await readdir(foreign), ['private.txt'])
    if (mode === 'snapshot-link') assert.deepEqual(await readFile(join(root, 'external-snapshot.json')), originalSnapshot)
    if (mode === 'resource-link') assert.equal(await readFile(join(root, 'saved-resource.txt'), 'utf8'), 'original bytes')
  } finally { await h.instance.close() }
})

test('persistence initialization failure releases the already-open dynamic store and permits a clean retry', async () => {
  const root = await temporary(), config = { dbPath: join(root, 'failed-start.sqlite'), instanceId: 'failed-start', initialize: true, workspaceDir: root }
  await assert.rejects(openTaskSessionService({ ctx: {}, config, legacy: { getAgentConfig: () => ({ workspaceDir: root }) } }), { code: 'TASK_SESSION_PERSISTENCE_REQUIRED' })
  const reopened = await openDynamicTaskStore({ dbPath: config.dbPath, instanceId: config.instanceId, initialize: false })
  try { assert.deepEqual(await reopened.query({ kind: 'task.list' }), []) } finally { await reopened.close() }
})
