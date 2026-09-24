import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedEdits } from '../packages/dingtalk-dsh-assistant/execution-edit.js'

const hash = text => createHash('sha256').update(text).digest('hex')
test('结构化受管编辑：预期hash、创建/替换/删除、回执丢失只读对账、拒绝重放', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  await writeFile(join(directory, 'a.txt'), 'old'); await writeFile(join(directory, 'delete.txt'), 'delete')
  const workspace = { directory, runId: 'run', generation: 1, requirementDigest: 'a'.repeat(64) }
  const adapter = createManagedEdits({ workspaceAdapter: { reconcile: async value => ({ status: value.directory === directory ? 'succeeded' : 'unknown' }) } })
  const prepared = await adapter.prepare({ workspace, changes: [
    { path: 'a.txt', expectedHash: hash('old'), content: 'new' },
    { path: 'nested/b.txt', expectedHash: null, content: 'created' },
    { path: 'delete.txt', expectedHash: hash('delete'), content: null },
  ] })
  assert.equal((await adapter.execute(prepared)).status, 'succeeded')
  assert.equal(await readFile(join(directory, 'a.txt'), 'utf8'), 'new')
  assert.equal((await adapter.reconcile(prepared)).status, 'succeeded')
  await assert.rejects(adapter.execute(prepared), { code: 'EDIT_BASE_CONFLICT' })
  await writeFile(join(directory, 'a.txt'), 'user edit')
  assert.equal((await adapter.reconcile(prepared)).status, 'unknown')
})

test('编辑拒绝越界、Git内部路径、大小写别名、文件目录碰撞以及过期内容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
  await mkdir(join(directory, 'dir')); await writeFile(join(directory, 'a.txt'), 'original')
  const workspace = { directory, runId: 'run', generation: 1, requirementDigest: 'a'.repeat(64) }
  const adapter = createManagedEdits({ workspaceAdapter: { reconcile: async () => ({ status: 'succeeded' }) } })
  for (const path of ['../x', '.git/config', 'C:/x', '/absolute', 'CON', 'x.', 'dir\\escape']) {
    await assert.rejects(adapter.prepare({ workspace, changes: [{ path, expectedHash: null, content: 'x' }] }), { code: 'EDIT_CHANGE_INVALID' })
  }
  await assert.rejects(adapter.prepare({ workspace, changes: ['x', 'X'].map(path => ({ path, expectedHash: null, content: 'x' })) }), { code: 'EDIT_CHANGE_INVALID' })
  await assert.rejects(adapter.prepare({ workspace, changes: ['x', 'x/y'].map(path => ({ path, expectedHash: null, content: 'x' })) }), { code: 'EDIT_PATH_COLLISION' })
  await assert.rejects(adapter.prepare({ workspace, changes: [{ path: 'a.txt', expectedHash: hash('stale'), content: 'new' }] }), { code: 'EDIT_BASE_CONFLICT' })
  assert.equal(await readFile(join(directory, 'a.txt'), 'utf8'), 'original')
})
