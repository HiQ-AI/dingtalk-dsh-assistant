import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts, readTaskMaterials } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskDirectoryResolver } from '../packages/dingtalk-dsh-assistant/execution.js'
import { createTaskArtifactFiles } from '../packages/dingtalk-dsh-assistant/task-artifact-files.js'
import { createTaskMarkdownFileAdapter } from '../packages/dingtalk-dsh-assistant/task-markdown-file.js'

const workflow = { id: 'storage-check', version: '1', nodes: [{ id: 'output', version: '1', executor: 'code', allowedEffects: ['pure'],
  inputSchema: { type: 'number' }, outputSchema: { type: 'number' }, mapInput: ({ requirement }) => requirement, execute: async ({ input }) => input + 1 }] }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'task-file-storage-')), workspaceRoot = join(root, 'agent')
  await mkdir(workspaceRoot)
  let store, controller, initialized = false
  async function close() { await controller?.close(); controller = undefined; await store?.close(); store = undefined }
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }) })
  async function open(scoped = true) {
    await close()
    store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'storage-test', initialize: !initialized })
    initialized = true
    const getTaskDirectories = scoped ? createTaskDirectoryResolver({ store, workspaceRoot }) : undefined
    const artifacts = await openExecutionArtifacts({ directory: join(root, 'shared'), initialize: true,
      ...(scoped ? { taskWorkspaceRoot: workspaceRoot, getTaskDirectories } : {}) })
    controller = createExecutionController({ store, artifacts, workflows: [workflow] })
    return { store, controller, artifacts, getTaskDirectories }
  }
  return { root, workspaceRoot, open }
}
async function run(controller, taskId, runId) {
  await controller.createRun({ commandId: `create-${runId}`, taskId, runId, workflowId: workflow.id, input: 7 })
  const result = await controller.whenIdle(runId)
  assert.equal(result.run.status, 'succeeded')
  return result
}

test('真实控制账升级保留旧任务裸引用，新任务全部工件按任务隔离并可重启读取', async t => {
  const f = await fixture(t)
  let app = await f.open(false)
  const old = await run(app.controller, 'old-task', 'old-run')
  assert.match(old.run.requirementRef, /^sha256-/)
  app = await f.open()
  assert.equal(await app.getTaskDirectories('old-task'), null)
  const oldAgain = await run(app.controller, 'old-task', 'old-run-again')
  assert.match(oldAgain.nodes[0].outputRef, /^sha256-/)
  const first = await run(app.controller, 'task-a', 'run-a'), second = await run(app.controller, 'task-b', 'run-b')
  for (const [state, id] of [[first, 'task-a'], [second, 'task-b']]) {
    for (const ref of [state.run.requirementRef, state.nodes[0].inputRef, state.nodes[0].outputRef, ...state.nodes[0].evidenceRefs]) {
      assert.ok(ref.startsWith(`tasks/${id}/`), ref)
      assert.equal(app.artifacts.locate(ref), join(f.workspaceRoot, 'tasks', id, 'work/artifacts', basename(ref)))
      await app.artifacts.read(ref)
    }
  }
  assert.notEqual(first.nodes[0].outputRef, second.nodes[0].outputRef)
  assert.equal(basename(first.nodes[0].outputRef), basename(second.nodes[0].outputRef))
  app = await f.open()
  assert.equal(await app.artifacts.read(first.nodes[0].outputRef), 8)
  assert.equal(await app.artifacts.read(old.nodes[0].outputRef), 8)
  assert.equal((await app.getTaskDirectories('task-a')).logicalTaskId, 'task-a')
  await assert.rejects(app.getTaskDirectories('task-a', { logicalTaskId: 'task-b' }), /TASK_DIRECTORY_IDENTITY_CONFLICT/)
})

test('任务工件损坏拒绝，缺文件不回退到相同摘要的共享工件', async t => {
  const f = await fixture(t), app = await f.open()
  const value = { evidence: 'same bytes' }
  const shared = await app.artifacts.put(value), scoped = await app.artifacts.put(value, { taskId: 'task-a' })
  assert.equal(basename(scoped.ref), shared.ref)
  const path = app.artifacts.locate(scoped.ref)
  await writeFile(path, '{}')
  await assert.rejects(app.artifacts.read(scoped.ref), { code: 'ARTIFACT_DIGEST_MISMATCH' })
  await assert.rejects(app.artifacts.put(value, { taskId: 'task-a' }), { code: 'ARTIFACT_DIGEST_MISMATCH' })
  await unlink(path)
  await assert.rejects(app.artifacts.read(scoped.ref), { code: 'ENOENT' })
  assert.deepEqual(await app.artifacts.read(shared.ref), value)
})

test('任务工件拒绝路径穿越、目录junction及最终路径junction', async t => {
  const f = await fixture(t), app = await f.open()
  await assert.rejects(app.artifacts.read(`tasks/../sha256-${'a'.repeat(64)}.json`), /ARTIFACT_REFERENCE_INVALID/)
  await assert.rejects(app.artifacts.put({}, { taskId: '../escape' }), /TASK_PLAN_ID_INVALID/)
  const outside = join(f.root, 'outside')
  await mkdir(outside);await mkdir(join(f.workspaceRoot, 'tasks'), { recursive: true })
  await symlink(outside, join(f.workspaceRoot, 'tasks/task-link'), 'junction')
  await assert.rejects(app.artifacts.put({}, { taskId: 'task-link' }), /TASK_DIRECTORY_OUTSIDE_ROOT/)
  const scoped = await app.artifacts.put({ value: 1 }, { taskId: 'task-safe' }), path = app.artifacts.locate(scoped.ref)
  const original = await readFile(path), source = join(outside, basename(path))
  await writeFile(source, original);await unlink(path);await symlink(outside, path, 'junction')
  await assert.rejects(app.artifacts.read(scoped.ref), /ARTIFACT_REFERENCE_INVALID/)
  await assert.rejects(app.artifacts.put({ value: 1 }, { taskId: 'task-safe' }), /ARTIFACT_REFERENCE_INVALID/)
  await unlink(path)
  await t.test('真实文件symlink读取和覆盖均拒绝', async child => {
    try { await symlink(source, path, 'file') }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
      child.skip('Windows 当前进程没有文件符号链接权限；目录junction反例已实跑')
      return
    }
    await assert.rejects(app.artifacts.read(scoped.ref), /ARTIFACT_REFERENCE_INVALID/)
    await assert.rejects(app.artifacts.put({ value: 1 }, { taskId: 'task-safe' }), /ARTIFACT_REFERENCE_INVALID/)
  })
})

test('真实任务resolver连接Markdown和交付文件，旧任务保留旧输出目录', async t => {
  const f = await fixture(t)
  let app = await f.open(false)
  await run(app.controller, 'old-task', 'old-run')
  app = await f.open()
  await run(app.controller, 'task-new', 'new-run')
  const legacyRoot = join(f.root, 'legacy-outputs')
  const files = createTaskArtifactFiles({ root: legacyRoot, getTaskDirectories: app.getTaskDirectories })
  const markdown = createTaskMarkdownFileAdapter({ root: legacyRoot, getTaskDirectories: app.getTaskDirectories })
  for (const taskId of ['old-task', 'task-new']) {
    const artifact = await files.register({ taskId, requirementRevision: 1, producer: { runId: 'file-run', nodeRunId: 'file-node', outputRef: 'source' },
      role: 'report', fileName: '报告.md', bytes: Buffer.from('交付内容') })
    const base = taskId === 'old-task' ? legacyRoot : join(f.workspaceRoot, 'tasks', taskId, 'outputs')
    assert.equal((await files.resolve(artifact)).path, join(base, taskId, artifact.artifactId, artifact.fileName))
    const prepared = markdown.prepare({ input: { content: '# 内容' }, binding: { taskId, runId: 'file-run', nodeRunId: 'file-node', generation: 1, requirementDigest: 'a'.repeat(64) } })
    assert.equal((await markdown.execute(prepared)).result.path, join(base, taskId, `${prepared.operationId}.md`))
  }
})

test('共享材料索引回填历史正文并即时发现新材料，不跨逻辑Task或公开内部账',async t=>{
 const f=await fixture(t),app=await f.open()
 const old=await app.artifacts.put({kind:'agent-query-evidence',execution:{taskId:'task-a',requirementRevision:1},result:{resource:{type:'doc',resourceId:'original-document'},markdown:'历史正文'.repeat(5000)}},{taskId:'task-a'})
 const hidden=await app.artifacts.put({kind:'node-dispatch-diagnostic',privateDiagnostic:'内部账'},{taskId:'task-a'})
 const foreign=await app.artifacts.put({id:'other',text:'其他任务材料'},{taskId:'task-b'})
 const directories=await app.getTaskDirectories('task-a')
 await writeFile(join(directories.outputs,'result.md'),'已生成产物')
 const options={directories,artifacts:app.artifacts,requirementRevision:2}
 let index=await readTaskMaterials(options)
 assert.deepEqual(index.entries.map(e=>e.artifactRef),[old.ref]);assert.equal(index.entries[0].status,'history');assert.equal(index.entries[0].resource.resourceId,'original-document')
 assert.equal(index.files[0].relativePath,'outputs/result.md')
 assert.equal(JSON.parse((await readTaskMaterials({...options,artifactRef:'outputs/result.md'})).artifact).text,'已生成产物')
 await assert.rejects(readTaskMaterials({...options,artifactRef:'outputs/../secret'}),{code:'TASK_MATERIAL_SCOPE_INVALID'})
 for(const path of ['work/engineering/repository/package.json','work/engineering/repository/.env','work/task/owner/session/context.json','tmp/internal/secret']) await assert.rejects(readTaskMaterials({...options,artifactRef:path}),{code:'TASK_MATERIAL_SCOPE_INVALID'})
 assert.ok((await readTaskMaterials({...options,artifactRef:`work/artifacts/${basename(old.ref)}`})).totalLength > 16000)
 assert.ok(!JSON.stringify(index).includes('历史正文'))
 let text='',offset=0
 do{const page=await readTaskMaterials({...options,artifactRef:old.ref,offset});text+=page.artifact;offset=page.nextOffset}while(offset!==null)
 assert.equal(JSON.parse(text).result.markdown,'历史正文'.repeat(5000))
 const next=await app.artifacts.put({kind:'agent-query-evidence',execution:{taskId:'task-a',requirementRevision:2},result:{markdown:'新增材料'}},{taskId:'task-a'})
 index=await readTaskMaterials(options);assert.equal(index.entries.length,2)
 assert.equal(index.entries.find(e=>e.artifactRef===next.ref).status,'current')
 assert.deepEqual(JSON.parse(await readFile(join(directories.work,'materials-index.json'),'utf8')),index)
 await assert.rejects(readTaskMaterials({...options,artifactRef:foreign.ref}),{code:'TASK_MATERIAL_SCOPE_INVALID'})
 await assert.rejects(readTaskMaterials({...options,artifactRef:'tasks/task-a/../secret'}),{code:'ARTIFACT_REFERENCE_INVALID'})
 assert.ok(!index.entries.some(e=>e.artifactRef===hidden.ref))
})
