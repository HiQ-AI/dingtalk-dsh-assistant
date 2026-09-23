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
