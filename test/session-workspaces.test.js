import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, symlink, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { executionSessionTitle, sessionWorkspace, sessionPurposes, sessionTitle, nameSession } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'

test('八种实际会话职责各有独立工作区，未知职责不创建目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-purposes-'))
  await writeFile(join(root, 'AGENTS.md'), '当前工作区指引')
  const directories = await Promise.all(Object.keys(sessionPurposes).map(role => sessionWorkspace(root, role)))
  assert.equal(new Set(directories).size, 8)
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
