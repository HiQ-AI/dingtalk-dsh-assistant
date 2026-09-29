import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, readFile, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { freezeCandidate, readCandidate, verifyCandidate, assertVerifiedCandidate } from '../packages/dingtalk-dsh-assistant/execution-candidate.js'

const root = resolve('docs/tmp/execution-candidate-tests')
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' }).trim()
async function fixture() {
  await mkdir(root, { recursive: true }); const repository = await mkdtemp(join(root, 'repo-'))
  git(repository, 'init', '-q'); git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repository, 'kept.txt'), 'base'); await writeFile(join(repository, 'deleted.txt'), 'delete me')
  await writeFile(join(repository, '.gitignore'), 'ignored.txt\n'); git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'fixture')
  return { repository, baseCommit: git(repository, 'rev-parse', 'HEAD'), generation: 1, requirementDigest: 'a'.repeat(64) }
}
test('冻结完整工作树包含新增删除，原索引和 HEAD 保持原样，验证只读固定字节', async () => {
  const args = await fixture(), indexPath = join(args.repository, '.git/index'), before = await readFile(indexPath)
  await writeFile(join(args.repository, 'kept.txt'), 'frozen'); await unlink(join(args.repository, 'deleted.txt'))
  await writeFile(join(args.repository, 'new.txt'), 'new'); await writeFile(join(args.repository, 'ignored.txt'), 'secret')
  const candidate = await freezeCandidate(args)
  assert.deepEqual(await readFile(indexPath), before); assert.equal(git(args.repository, 'rev-parse', 'HEAD'), args.baseCommit)
  await writeFile(join(args.repository, 'kept.txt'), 'different'); await unlink(join(args.repository, 'new.txt'))
  const snapshot = await readCandidate(candidate)
  assert.deepEqual(snapshot.files.map(file => file.path), ['.gitignore', 'kept.txt', 'new.txt'])
  assert.equal((await snapshot.readFile('kept.txt')).toString(), 'frozen')
  const verification = await verifyCandidate({ candidate, checks: [{ id: 'bytes', version: '1', run: async view => ({ passed: (await view.readFile('new.txt')).toString() === 'new', log: 'frozen new bytes matched' }) }] })
  assert.equal(verification.passed, true); assert.ok(Object.isFrozen(verification.checks[0]))
  assert.equal((await assertVerifiedCandidate({ candidate, verification, requiredChecks: [{ id: 'bytes', version: '1' }] })).candidate.tree, candidate.tree)
  await assert.rejects(assertVerifiedCandidate({ candidate, verification: structuredClone(verification), requiredChecks: [{ id: 'bytes', version: '1' }] }), { code: 'CANDIDATE_VERIFICATION_UNTRUSTED' })
  await assert.rejects(assertVerifiedCandidate({ candidate, verification, requiredChecks: [{ id: 'bytes', version: '2' }] }), { code: 'CANDIDATE_REQUIRED_CHECKS_MISMATCH' })
})
test('拒绝伪造候选身份，失败和异常检查不能形成交付资格', async () => {
  const candidate = await freezeCandidate(await fixture())
  await assert.rejects(readCandidate({ ...candidate, generation: 2 }), { code: 'CANDIDATE_DIGEST_INVALID' })
  const verification = await verifyCandidate({ candidate, checks: [{ id: 'failure', version: '1', run: async () => { throw new Error('fixture failure') } }] })
  assert.equal(verification.passed, false); assert.equal(verification.checks[0].log, 'fixture failure')
  await assert.rejects(assertVerifiedCandidate({ candidate, verification, requiredChecks: [{ id: 'failure', version: '1' }] }), { code: 'CANDIDATE_VERIFICATION_UNTRUSTED' })
  await assert.rejects(verifyCandidate({ candidate, checks: [{ id: 'bad', version: '1', run: async () => ({ passed: true, log: 'x'.repeat(65537) }) }] }), { code: 'CANDIDATE_CHECK_RESULT_INVALID' })
})
test('符号链接模式和子模块模式在实际 Git 索引中拒绝', async () => {
  for (const mode of ['120000', '160000']) {
    const args = await fixture(), hash = mode === '160000' ? args.baseCommit : git(args.repository, 'rev-parse', 'HEAD:kept.txt')
    git(args.repository, 'update-index', '--add', '--cacheinfo', `${mode},${hash},unsupported`)
    await assert.rejects(freezeCandidate(args), { code: 'CANDIDATE_INDEX_UNSUPPORTED' })
  }
})
test('存在执行过滤器或真实 hook 时拒绝准入，未调用其命令', async () => {
  const filter = await fixture(); git(filter.repository, 'config', 'filter.test.clean', 'exit 9')
  await writeFile(join(filter.repository, '.gitattributes'), '*.txt filter=test\n')
  await assert.rejects(freezeCandidate(filter), { code: 'CANDIDATE_UNSUPPORTED_GIT_EXTENSION' })
  const hook = await fixture(); await writeFile(join(hook.repository, '.git/hooks/pre-commit'), 'exit 9')
  await assert.rejects(freezeCandidate(hook), { code: 'CANDIDATE_HOOKS_UNSUPPORTED' })
})

test('Git batch保留空blob/重复blob/二进制及Unicode路径，返回字节不共享可变缓存', async () => {
  const args=await fixture(),binary=Buffer.from([0,10,13,255,128,32,0])
  await writeFile(join(args.repository,'中文 空文件.txt'),Buffer.alloc(0));await writeFile(join(args.repository,'a.bin'),binary);await writeFile(join(args.repository,'b.bin'),binary)
  const candidate=await freezeCandidate(args),snapshot=await readCandidate(candidate)
  assert.deepEqual(await snapshot.readFile('中文 空文件.txt'),Buffer.alloc(0))
  const changed=await snapshot.readFile('a.bin');changed.fill(42)
  assert.deepEqual(await snapshot.readFile('a.bin'),binary);assert.deepEqual(await snapshot.readFile('b.bin'),binary)
  const file=snapshot.files.find(f=>f.path==='a.bin'),{deflateSync}=await import('node:zlib'),{chmod}=await import('node:fs/promises')
  const objectPath=join(args.repository,'.git','objects',file.oid.slice(0,2),file.oid.slice(2));await chmod(objectPath,0o600)
  await writeFile(objectPath,deflateSync(Buffer.concat([Buffer.from(`blob ${binary.length}\0`),Buffer.alloc(binary.length,33)])))
  const independent=await readCandidate(candidate)
  await assert.rejects(independent.readFile('a.bin'),{code:'CANDIDATE_BLOB_INVALID'})
})

test('终态文件迁入任务目录并保留普通硬链接，原candidate身份与cwd可读，支持回滚', async () => {
 const { checkMigration, executeMigration, verifyMigration, rollbackMigration } = await import('../scripts/migrate-task-file-links.mjs')
 const { lstat, realpath, readdir } = await import('node:fs/promises')
 const args = await fixture(), candidate = await freezeCandidate(args)
 const targetRoot = await mkdtemp(join(root, 'migration-')), destination = join(targetRoot, 'task', 'repository'), journalPath = join(targetRoot, 'journal.json')
 const plan = { version: 1, entries: [{ source: args.repository, destination }] }
 const before = await readdir(targetRoot), preview = await checkMigration(plan)
 assert.ok(preview.files > 3); assert.deepEqual(await readdir(targetRoot), before)
 const migrated = await executeMigration(plan, journalPath)
 assert.equal(migrated.verified, true)
 assert.equal(await realpath(args.repository), args.repository)
 assert.equal((await lstat(join(args.repository, 'kept.txt'), { bigint: true })).ino, (await lstat(join(destination, 'kept.txt'), { bigint: true })).ino)
 assert.equal(git(args.repository, 'rev-parse', 'HEAD'), args.baseCommit)
 assert.equal((await (await readCandidate(candidate)).readFile('kept.txt')).toString(), 'base')
 const journal = JSON.parse(await readFile(journalPath, 'utf8'))
 assert.equal((await verifyMigration(journal)).verified, true)
 assert.equal((await rollbackMigration(journal)).rolledBack, true)
 assert.equal(await readFile(join(args.repository, 'kept.txt'), 'utf8'), 'base')
 await assert.rejects(readFile(join(destination, 'kept.txt')), { code: 'ENOENT' })
 assert.equal((await (await readCandidate(candidate)).readFile('kept.txt')).toString(), 'base')
})

test('硬链接迁移拒绝祖先链接，rename后中断可依据只读清单恢复', async () => {
 const { checkMigration, rollbackMigration } = await import('../scripts/migrate-task-file-links.mjs')
 const { symlink, rename, readdir } = await import('node:fs/promises')
 await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(root, 'migration-crash-'))
 const source = join(directory, 'source.txt'), outside = join(directory, 'outside'), alias = join(directory, 'alias')
 await writeFile(source, 'frozen'); await mkdir(outside); await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
 await assert.rejects(checkMigration({ version: 1, entries: [{ source, destination: join(alias, 'new', 'file') }] }), /TASK_DIRECTORY_OUTSIDE_ROOT/)
 assert.deepEqual(await readdir(outside), [])
 const destination = join(directory, 'moved.txt'), journal = await checkMigration({ version: 1, entries: [{ source, destination }] })
 await rename(source, destination)
 await rollbackMigration(journal)
 assert.equal(await readFile(source, 'utf8'), 'frozen'); await assert.rejects(readFile(destination), { code: 'ENOENT' })
})

test('共享JSON源可链接到两个任务，执行及第二目标rename中断均可回滚', async () => {
 const { checkMigration, executeMigration, verifyMigration, rollbackMigration } = await import('../scripts/migrate-task-file-links.mjs')
 const { rename, lstat } = await import('node:fs/promises')
 await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(root, 'migration-shared-'))
 const sourceRoot = join(directory, 'source'); await mkdir(sourceRoot)
 const source = join(sourceRoot, 'shared.json'), a = join(directory, 'task-a', 'shared.json'), b = join(directory, 'task-b', 'shared.json')
 await writeFile(source, '{}')
 const plan = { version: 1, entries: [{ source, destination: a }, { source, destination: b }] }, journalPath = join(directory, 'journal.json')
 await executeMigration(plan, journalPath)
 const journal = JSON.parse(await readFile(journalPath, 'utf8'))
 assert.equal((await verifyMigration(journal)).verified, true)
 assert.equal((await lstat(a, { bigint: true })).ino, (await lstat(b, { bigint: true })).ino)
 await rollbackMigration(journal)
 await rename(source, a)
 const { link } = await import('node:fs/promises'); await link(a, source)
 await rename(source, b)
 await rollbackMigration(journal)
 assert.equal(await readFile(source, 'utf8'), '{}')
 for (const path of [a, b]) await assert.rejects(readFile(path), { code: 'ENOENT' })
 await assert.rejects(checkMigration({ version: 1, entries: [{ source, destination: a }, { source, destination: a }] }), /MIGRATION_DUPLICATE_PATH/)
})

test('迁移计划显式排除可再生node_modules链接，不遍历也不移动缓存', async () => {
 const { checkMigration } = await import('../scripts/migrate-task-file-links.mjs')
 const { symlink } = await import('node:fs/promises')
 await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(root, 'migration-cache-')), source = join(directory, 'source'), cache = join(directory, 'cache')
 await mkdir(source); await mkdir(cache); await writeFile(join(source, 'kept.txt'), 'source'); await writeFile(join(cache, 'dependency.js'), 'cache')
 await symlink(cache, join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
 const entry = { source, destination: join(directory, 'target'), exclude: ['node_modules'] }
 const result = await checkMigration({ version: 1, entries: [entry] })
 assert.equal(result.files, 1); assert.equal(result.mappings[0].source, join(source, 'kept.txt'))
 await writeFile(join(source, 'kept.txt'), 'changed after review')
 await assert.rejects(checkMigration({ version: 1, entries: [entry], expectedManifestDigest: result.manifestDigest }), /MIGRATION_REVIEWED_MANIFEST_CHANGED/)
 await assert.rejects(checkMigration({ version: 1, entries: [{ ...entry, exclude: ['../cache'] }] }), /MIGRATION_EXCLUSION_INVALID/)
})

test('迁移备份去重共享源并创建独立普通副本，源变化不改备份且损坏可检出', async () => {
 const { backupMigration, verifyMigrationBackup } = await import('../scripts/migrate-task-file-links.mjs')
 const { lstat } = await import('node:fs/promises')
 await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(root, 'migration-backup-'))
 const source = join(directory, 'source.json'); await writeFile(source, '{"result":"original"}')
 const { chmod } = await import('node:fs/promises'); await chmod(source, 0o444)
 const plan = { version: 1, entries: [{ source, destination: join(directory, 'task-a', 'source.json') }, { source, destination: join(directory, 'task-b', 'source.json') }] }
 const result = await backupMigration(plan, join(directory, 'backup'))
 assert.equal(result.files, 1); assert.equal(result.verified, true)
 const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')), copy = manifest.mappings[0].backup
 assert.notEqual((await lstat(source, { bigint: true })).ino, (await lstat(copy, { bigint: true })).ino)
 assert.equal((await verifyMigrationBackup(result.manifestPath)).verified, true)
 await chmod(source, 0o600)
 await writeFile(source, 'later original-path write')
 assert.equal(await readFile(copy, 'utf8'), '{"result":"original"}')
 assert.equal((await verifyMigrationBackup(result.manifestPath)).verified, true)
 await chmod(copy, 0o600)
 await writeFile(copy, 'corrupted')
 await assert.rejects(verifyMigrationBackup(result.manifestPath), /MIGRATION_FILE_CHANGED/)
})
