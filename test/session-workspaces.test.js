import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, symlink, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { executionSessionTitle, sessionWorkspace, sessionPurposes, sessionTitle, nameSession, materializeExecutionDocument, renderExecutionDocument } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'

test('九种实际会话职责各有独立工作区，未知职责不创建目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-purposes-'))
  await writeFile(join(root, 'AGENTS.md'), '当前工作区指引')
  const directories = await Promise.all(Object.keys(sessionPurposes).map(role => sessionWorkspace(root, role)))
  assert.equal(new Set(directories).size, 9)
  assert.deepEqual(directories.map(dir => relative(root, dir)), Object.values(sessionPurposes).map(label => join('session-workspaces', label)))
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '当前工作区指引')
  await assert.rejects(sessionWorkspace(root, 'intent'), /SESSION_WORKSPACE_INVALID/)
  await assert.rejects(sessionWorkspace('relative', 'owner'), /SESSION_WORKSPACE_INVALID/)
})

test('配置根之外的目录链接必须拒绝，不能在外部创建职责目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-root-')), outside = await mkdtemp(join(tmpdir(), 'session-outside-'))
  await symlink(outside, join(root, 'session-workspaces'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(sessionWorkspace(root, 'answer'), /SESSION_WORKSPACE_OUTSIDE_ROOT/)
  await assert.rejects(readFile(join(outside, '消息问答')), { code: 'ENOENT' })
  const clean = await mkdtemp(join(tmpdir(), 'session-link-'))
  await mkdir(join(clean, 'session-workspaces'))
  await symlink(outside, join(clean, 'session-workspaces', '任务执行'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(sessionWorkspace(clean, 'execution'), /SESSION_WORKSPACE_OUTSIDE_ROOT/)
})

test('原生标题包含事项和职责，去除内部身份、网址与本机路径', () => {
  const subject = '草稿字段查询 task-1234567890abcdef1234567890abcdef sessionId=secret https://example.test/a D:\\private\\secret.txt'
  assert.equal(sessionTitle('answer', subject), '草稿字段查询 · 消息问答')
  assert.equal(sessionTitle('owner', ''), '任务负责')
  assert.throws(() => sessionTitle('intent', subject), /SESSION_PURPOSE_INVALID/)
  let saved
  nameSession({ sessionTitle: { rename: (session, title) => { saved = { session, title } } } }, { id: 'internal' }, 'owner', '导出报告')
  assert.equal(saved.title, '导出报告 · 任务负责')
})

test('执行名称统一复用原生简短清理逻辑，持久名称优先于续办输入',()=>{
 assert.equal(executionSessionTitle({title:'核对配置',input:{title:'续办目标'}}),'核对配置')
 assert.equal([...executionSessionTitle({input:{title:'核对😀'.repeat(30)}})].length,28)
 assert.equal(executionSessionTitle({key:'检查服务',input:{objective:'完整目标'.repeat(100)}}),'检查服务')
 assert.equal(executionSessionTitle({}),'任务执行')
})

test('仅显式中文title作为新短名，否则沿用key，不以长目标或动作词替代',()=>{
 assert.equal(executionSessionTitle({input:{title:'验证 PostgreSQL 连接',objective:'Verify connection'},key:'verify-db'}),'验证 PostgreSQL 连接')
 assert.equal(executionSessionTitle({input:{title:'english-new-title',objective:'Verify API behavior'},key:'api-check'}),'api-check')
 assert.equal(executionSessionTitle({input:{title:'  ',objective:'Read logs'},key:'read-logs'}),'read-logs')
 assert.equal(executionSessionTitle({input:{objective:'核对完整目标'.repeat(30)},key:'legacy-inspection'}),'legacy-inspection')
 assert.equal(executionSessionTitle({input:{objective:'Investigate database timeout'},key:'inspect-db'}),'inspect-db')
 assert.equal(executionSessionTitle({title:'legacy-english',input:{title:'新名称',objective:'New goal'}}),'legacy-english')
 assert.equal(executionSessionTitle({executionId:'legacy-no-title-field',input:{title:'legacy-english',objective:'Verify API'}}),'legacy-english')
})

function documentedExecution() {
  return { taskId: 'task-docs', executionId: 'execution-docs', sessionId: 'execution-session-docs', inputVersion: 1,
    requirementRevision: 1, controlRevision: 1, leaseEpoch: 1, status: 'running', drained: false, updatedAt: '2026-10-22T10:00:00.000Z',
    input: { objective: '确认安装指令及目标版本', context: '只读 README；不安装，不改其他文件。' },
    stageProgress: { inputVersion: 1, requirementRevision: 1, controlRevision: 1, leaseEpoch: 1, sequence: 1,
      recordedAt: '2026-10-22T10:00:00.000Z', plan: '1. 读指定行\n2. 核对版本', summary: '已读取安装行，版本尚待核对。', activity: '核对版本', evidence: ['README.md:4 已独立读回'] },
    resources: { state: 'none', keys: [], holder: null, blocking: [] }, feedback: [] }
}

test('执行文档只投影本轮计划证据和结果，明确活动与反馈消费的边界', () => {
  const execution = documentedExecution()
  execution.result = { inputVersion: 1, requirementRevision: 1, controlRevision: 1, leaseEpoch: 1, current: true,
    receivedAt: '2026-10-22T10:01:00.000Z', payload: { output: { summary: '版本一致。', evidence: ['A=2.4.1; B=2.4.1'], artifacts: ['result.txt'], limitations: ['未执行安装'] } } }
  execution.feedback = [
    { id: 'owner-note', inputVersion: 1, requirementRevision: 1, controlRevision: 1, text: '原始反馈'.repeat(10000), consumedAt: null },
    { id: 'peer-note', inputVersion: 1, requirementRevision: 1, controlRevision: 1, sourceExecutionId: 'peer-a', sourceInputVersion: 2, sourceLeaseEpoch: 3, consumedAt: '2026-10-22T10:00:00.000Z' },
    { id: 'stale-peer-note', inputVersion: 2, requirementRevision: 1, controlRevision: 1, sourceExecutionId: 'peer-b' },
  ]
  const doc = renderExecutionDocument(execution)
  for (const expected of ['只读 README', '1. 读指定行\n> 2. 核对版本', 'README.md:4', 'A=2.4.1; B=2.4.1', 'result.txt', '未执行安装',
    '执行报告不等于独立核验', '活动只表示报告时的活动', '消费只证明进入模型步骤', 'messageId: owner-note', '来源: 执行 peer-a']) assert.ok(doc.includes(expected), expected)
  assert.ok(!doc.includes('stale-peer-note'))
  assert.ok(!doc.includes('原始反馈'))
  const next = renderExecutionDocument({ ...execution, inputVersion: 2, result: null })
  assert.ok(next.includes('报告属于 inputVersion=1'))
  assert.ok(next.includes('尚未报告计划'))
  assert.ok(!next.includes('README.md:4'))
  assert.ok(!next.includes('A=2.4.1'))
  assert.ok(next.includes('messageId: owner-note'))
  assert.ok(!next.includes('messageId: peer-note'))
})

test('同轮阶段和排空更新原子刷新；新轮保留旧文件并拒绝倒填历史', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-doc-rounds-')), execution = documentedExecution()
  const first = await materializeExecutionDocument(root, execution)
  assert.equal(relative(root, first.path), join('tasks', execution.taskId, 'outputs', execution.executionId, 'round-1.md'))
  const firstBytes = await readFile(first.path)
  assert.equal(first.sha256, createHash('sha256').update(firstBytes).digest('hex'))
  assert.equal(first.bytes, firstBytes.length)
  execution.status = 'succeeded'; execution.drained = true; execution.stageProgress.sequence++
  execution.stageProgress.summary = '原安装行和版本已读回。'
  const final = await materializeExecutionDocument(root, execution), finalBytes = await readFile(final.path)
  assert.notEqual(final.sha256, first.sha256)
  assert.ok(finalBytes.toString().includes('drained: true'))
  const next = { ...execution, inputVersion: 2, status: 'queued', input: { objective: '只读核对新增配置', context: '不复用上一轮结论。' } }
  const second = await materializeExecutionDocument(root, next)
  assert.equal(relative(root, second.path), join('tasks', execution.taskId, 'outputs', execution.executionId, 'round-2.md'))
  assert.ok((await readFile(second.path, 'utf8')).includes('已安排，待启动'))
  assert.deepEqual(await readFile(first.path), finalBytes)
  assert.equal((await materializeExecutionDocument(root, execution)).sha256, final.sha256)
  await assert.rejects(materializeExecutionDocument(root, { ...execution, input: next.input }), { code: 'EXECUTION_DOCUMENT_ROUND_FROZEN' })
  assert.deepEqual(await readFile(first.path), finalBytes)
  assert.deepEqual((await readdir(join(root, 'tasks', execution.taskId, 'outputs', execution.executionId))).sort(), ['round-1.md', 'round-2.md'])
})

test('文档路径或内容身份错误拒绝写入，不接受调用者路径或覆盖异执行文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-doc-identity-')), execution = documentedExecution()
  await assert.rejects(materializeExecutionDocument(root, { ...execution, executionId: '../outside' }), /TASK_DIRECTORY_INVALID/)
  await assert.rejects(materializeExecutionDocument(root, { ...execution, inputVersion: 0 }), { code: 'EXECUTION_DOCUMENT_IDENTITY_INVALID' })
  const saved = await materializeExecutionDocument(root, execution)
  const alien = renderExecutionDocument({ ...execution, executionId: 'other-execution' })
  await writeFile(saved.path, alien)
  await assert.rejects(materializeExecutionDocument(root, execution), { code: 'EXECUTION_DOCUMENT_IDENTITY_MISMATCH' })
  assert.equal(await readFile(saved.path, 'utf8'), alien)
})

test('文档输出目录 junction 不得写出 Task 边界，目标文件也不能是目录链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-doc-root-')), outside = await mkdtemp(join(tmpdir(), 'execution-doc-outside-'))
  const execution = documentedExecution(), outputs = join(root, 'tasks', execution.taskId, 'outputs')
  await mkdir(outputs, { recursive: true })
  await symlink(outside, join(outputs, execution.executionId), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(materializeExecutionDocument(root, execution), /TASK_DIRECTORY_OUTSIDE_ROOT/)
  assert.deepEqual(await readdir(outside), [])
  const clean = await mkdtemp(join(tmpdir(), 'execution-doc-clean-')), directory = join(clean, 'tasks', execution.taskId, 'outputs', execution.executionId)
  await mkdir(directory, { recursive: true })
  await symlink(outside, join(directory, 'round-1.md'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(materializeExecutionDocument(clean, execution), { code: 'EXECUTION_DOCUMENT_PATH_INVALID' })
  assert.deepEqual(await readdir(outside), [])
})
